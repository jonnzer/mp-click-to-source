function installMpClickToSource(options) {
  var config = Object.assign({
    host: '127.0.0.1',
    port: 17365,
    trigger: 'option-click',
    hover: true,
    devtoolsOnly: true,
    hoverThrottleMs: 48,
    rectCacheTtl: 500,
    hideDelayMs: 120,
    rectPendingTimeoutMs: 1200,
    overlayArbitrationMs: 150,
    pointFreshnessMs: 250,
    overlayLabel: false,
    modifierWaitMs: 25000,
    modifierMinIntervalMs: 1000,
    modifierRetryBackoffMs: [1000, 2000, 5000, 10000, 30000],
    enabledStorageKey: '__MP_CLICK_TO_SOURCE_ENABLED__'
  }, options || {});

  if (typeof wx === 'undefined') return;
  if (wx.__mpClickToSourceInstalled) return;

  var wxApi = wx;
  var windowSize = null;

  // 真机上拿不到 127.0.0.1 服务，避免无谓重试；只排除真机平台——
  // 模拟器的 PC/mac 模式 platform 是 'mac'/'windows' 而非 'devtools'，同样应该生效
  try {
    var deviceInfo = null;
    if (typeof wxApi.getDeviceInfo === 'function') {
      deviceInfo = wxApi.getDeviceInfo();
    } else if (typeof wxApi.getSystemInfoSync === 'function') {
      deviceInfo = wxApi.getSystemInfoSync();
    }
    var platform = deviceInfo && deviceInfo.platform || '';
    if (
      config.devtoolsOnly !== false &&
      (platform === 'ios' || platform === 'android' || platform === 'ohos')
    ) {
      return;
    }
  } catch (ignoreDeviceInfoError) {}

  try {
    var windowInfo = null;
    if (typeof wxApi.getWindowInfo === 'function') {
      windowInfo = wxApi.getWindowInfo();
    } else if (typeof wxApi.getSystemInfoSync === 'function') {
      windowInfo = wxApi.getSystemInfoSync();
    }
    if (windowInfo) {
      windowSize = { width: windowInfo.windowWidth || 0, height: windowInfo.windowHeight || 0 };
    }
  } catch (ignoreWindowInfoError) {}

  wxApi.__mpClickToSourceInstalled = true;

  var baseUrl = 'http://' + config.host + ':' + config.port;
  var state = {
    enabled: config.trigger !== 'tap',
    modifierActive: false,
    serverOnline: false
  };
  var pageContexts = [];
  var overlayContexts = [];
  // 全局单框仲裁：页面与各自定义组件都有独立的 overlay 实例，指针落在组件内部时
  // 页面上下文（只能命中组件宿主/底下的节点）和组件上下文会同时渲染，必须裁决出唯一高亮
  var currentOverlay = { context: null, area: 0, at: 0 };
  var lastRequestKey = '';
  var lastRequestAt = 0;
  var poll = {
    started: false,
    hidden: false,
    failures: 0,
    timer: null,
    task: null
  };
  // 排查用计数器，wx.__mpClickToSource.getDebugInfo() 可读
  var debug = {
    hoverEvents: 0,
    renders: 0,
    lastPoint: null,
    lastRectCount: -1,
    lastError: null
  };

  function schedule(fn, delay) {
    var timer = setTimeout(fn, delay);
    if (timer && typeof timer.unref === 'function') timer.unref();
    return timer;
  }

  function removeFromList(list, item) {
    var index = list.indexOf(item);
    if (index !== -1) list.splice(index, 1);
  }

  function isEnabled() {
    if (config.trigger !== 'tap') return true;

    try {
      var stored = wxApi.getStorageSync(config.enabledStorageKey);
      if (typeof stored === 'boolean') return stored;
    } catch (error) {
      // Ignore storage errors in devtools sandbox.
    }

    return state.enabled;
  }

  function setEnabled(value) {
    state.enabled = !!value;
    try {
      wxApi.setStorageSync(config.enabledStorageKey, state.enabled);
    } catch (error) {
      // Ignore storage errors in devtools sandbox.
    }
  }

  function getDataset(event) {
    var targetDataset = event && event.target && event.target.dataset;
    var currentDataset = event && event.currentTarget && event.currentTarget.dataset;
    return (targetDataset && targetDataset.codeLoc ? targetDataset : currentDataset) || {};
  }

  function getCurrentDataset(event) {
    return (event && event.currentTarget && event.currentTarget.dataset) || {};
  }

  // ---------------------------------------------------------------------------
  // 修饰键状态同步：长轮询（服务端挂起请求直到状态变化），
  // 空闲时约 25s 一个请求；服务不在线时指数退避，onAppHide 时完全暂停。
  // ---------------------------------------------------------------------------

  // 把修饰键状态写入页面 data，驱动 WXML 里的条件 catchtouchmove：
  // 按住修饰键时拖动被接管（不滚动页面），松开后绑定为空串、滚动恢复正常
  function setContextActive(context, active) {
    if (!context || context.__mpCodeInspectorDestroyed || typeof context.setData !== 'function') return;
    if (context.__mpCodeInspectorActiveFlag === active) return;

    context.__mpCodeInspectorActiveFlag = active;
    context.setData({ __mpCodeInspectorActive: active });
  }

  function setModifierActive(active) {
    active = !!active;
    if (state.modifierActive === active) return;

    state.modifierActive = active;
    var contexts = pageContexts.slice();
    for (var index = 0; index < contexts.length; index += 1) {
      setContextActive(contexts[index], active);
    }
    if (!active) hideAllOverlays();
  }

  function requestModifierState(waitMs) {
    var startedAt = Date.now();
    var url = baseUrl + '/modifier';
    if (waitMs > 0) {
      url += '?wait=' + waitMs + '&known=' + (state.modifierActive ? 1 : 0);
    }

    var task = wxApi.request({
      url: url,
      method: 'GET',
      timeout: (waitMs || 0) + 10000,
      success: function success(res) {
        poll.task = null;
        poll.failures = 0;
        state.serverOnline = true;
        var data = res && res.data || {};
        setModifierActive(data.active === true);
        if (waitMs > 0) scheduleNextPoll(startedAt);
      },
      fail: function fail() {
        poll.task = null;
        state.serverOnline = false;
        setModifierActive(false);
        if (waitMs > 0) {
          poll.failures += 1;
          var backoff = config.modifierRetryBackoffMs;
          schedulePoll(backoff[Math.min(poll.failures, backoff.length) - 1]);
        }
      }
    });
    poll.task = task || null;
  }

  function scheduleNextPoll(startedAt) {
    // 老版本服务不支持长轮询会立即返回，这里兜底一个最小间隔避免打爆请求
    var elapsed = Date.now() - startedAt;
    schedulePoll(elapsed < config.modifierMinIntervalMs ? config.modifierMinIntervalMs - elapsed : 0);
  }

  function schedulePoll(delay) {
    if (poll.hidden || config.hover === false) return;
    if (poll.timer) clearTimeout(poll.timer);
    poll.timer = schedule(function () {
      poll.timer = null;
      requestModifierState(config.modifierWaitMs);
    }, delay);
  }

  function startModifierSync() {
    if (poll.started || config.hover === false) return;
    poll.started = true;

    if (typeof wxApi.onAppHide === 'function') {
      wxApi.onAppHide(function () {
        poll.hidden = true;
        if (poll.timer) {
          clearTimeout(poll.timer);
          poll.timer = null;
        }
        if (poll.task && typeof poll.task.abort === 'function') {
          try {
            poll.task.abort();
          } catch (ignoreAbortError) {}
        }
        setModifierActive(false);
      });
    }
    if (typeof wxApi.onAppShow === 'function') {
      wxApi.onAppShow(function () {
        if (!poll.hidden) return;
        poll.hidden = false;
        poll.failures = 0;
        schedulePoll(0);
      });
    }

    requestModifierState(config.modifierWaitMs);
  }

  // ---------------------------------------------------------------------------
  // hover 高亮
  // ---------------------------------------------------------------------------

  function buildOverlayStyle(rect) {
    var left = Math.round(rect.left);
    var top = Math.round(rect.top);
    var width = Math.max(0, Math.round(rect.width));
    var height = Math.max(0, Math.round(rect.height));

    return [
      'position:fixed',
      'left:' + left + 'px',
      'top:' + top + 'px',
      'width:' + width + 'px',
      'height:' + height + 'px',
      'box-sizing:border-box',
      'pointer-events:none',
      'z-index:2147483647',
      'border-radius:0px',
      'background-color:transparent',
      'background-repeat:no-repeat',
      'background-image:linear-gradient(90deg,#4285f4 0%,#7bb6ff 16%,#ea4335 38%,#fbbc05 64%,#34a853 100%),linear-gradient(90deg,#34a853 0%,#fbbc05 32%,#ea4335 62%,#4285f4 100%),linear-gradient(180deg,#4285f4 0%,#ea4335 35%,#fbbc05 68%,#34a853 100%),linear-gradient(180deg,#34a853 0%,#fbbc05 32%,#ea4335 66%,#4285f4 100%)',
      'background-size:100% 2px,100% 2px,2px 100%,2px 100%',
      'background-position:left top,left bottom,left top,right top',
      'box-shadow:none'
    ].join(';');
  }

  function buildLabelStyle(rect) {
    var placeAbove = rect.top >= 28;
    return [
      'position:absolute',
      placeAbove ? 'top:-24px' : 'top:4px',
      'left:' + (placeAbove ? '-2px' : '4px'),
      'max-width:640px',
      'overflow:hidden',
      'white-space:nowrap',
      'padding:2px 8px',
      'font-size:10px',
      'line-height:16px',
      'font-family:Menlo,Consolas,monospace',
      'color:#ffffff',
      'background:rgba(32,33,36,0.92)',
      'border-radius:6px',
      'pointer-events:none'
    ].join(';');
  }

  function unique(values) {
    var output = [];

    for (var index = 0; index < values.length; index += 1) {
      var value = values[index];
      if (value && output.indexOf(value) === -1) output.push(value);
    }

    return output;
  }

  function getCodeIdCandidates(event) {
    var targetDataset = event && event.target && event.target.dataset || {};
    var currentDataset = event && event.currentTarget && event.currentTarget.dataset || {};

    return unique([
      targetDataset.codeId,
      currentDataset.codeId
    ]);
  }

  function cancelScheduledHide(context) {
    if (context && context.__mpCodeInspectorHideTimer) {
      clearTimeout(context.__mpCodeInspectorHideTimer);
      context.__mpCodeInspectorHideTimer = null;
    }
  }

  // 延迟隐藏：节点间移动时 mouseout(旧节点) 常晚于 mousemove(新节点) 到达，
  // 立即隐藏会造成高亮闪烁。新的渲染会取消这次隐藏；
  // 到期时若指针"最近"仍停留在当前高亮矩形内（如进入子节点触发了父节点 mouseout），也不隐藏。
  // 必须校验指针数据的新鲜度：指针移到其他上下文后本上下文不再收到事件，
  // 拿过期坐标判断会让旧框永远赖着不走（多框叠加的元凶之一）。
  function scheduleHide(context) {
    if (!context || context.__mpCodeInspectorDestroyed) return;
    if (!context.__mpCodeInspectorOverlayVisible) return;
    if (context.__mpCodeInspectorHideTimer) return;

    context.__mpCodeInspectorHideTimer = schedule(function () {
      context.__mpCodeInspectorHideTimer = null;
      if (
        state.modifierActive &&
        context.__mpCodeInspectorLastHitRect &&
        Date.now() - (context.__mpCodeInspectorLastPointAt || 0) < config.pointFreshnessMs &&
        isPointInRect(
          toViewportPoint(context, context.__mpCodeInspectorLastPoint),
          context.__mpCodeInspectorLastHitRect
        )
      ) {
        return;
      }
      hideOverlay(context);
    }, config.hideDelayMs);
  }

  function hideOverlay(context) {
    if (!context) return;

    if (currentOverlay.context === context) {
      currentOverlay = { context: null, area: 0, at: 0 };
    }
    cancelScheduledHide(context);
    removeFromList(overlayContexts, context);

    var wasVisible = context.__mpCodeInspectorOverlayVisible;
    context.__mpCodeInspectorOverlayVisible = false;
    context.__mpCodeInspectorHoverDataset = null;
    context.__mpCodeInspectorLastOverlayKey = '';

    if (!wasVisible || context.__mpCodeInspectorDestroyed || typeof context.setData !== 'function') return;

    context.setData({
      __mpCodeInspectorOverlay: {
        visible: false,
        style: '',
        label: '',
        labelStyle: ''
      }
    });
  }

  function hideAllOverlays() {
    var contexts = overlayContexts.slice();
    for (var index = 0; index < contexts.length; index += 1) {
      hideOverlay(contexts[index]);
    }
  }

  // 坐标归一化：touch.clientX 是视口坐标，可直接和 boundingClientRect 对比；
  // 鼠标事件的 detail.x/y 是页面坐标（含滚动量），命中前需要减去滚动偏移。
  function getPointerPoint(event) {
    var touch = event && (event.touches && event.touches[0] || event.changedTouches && event.changedTouches[0]) || null;

    if (touch) {
      if (typeof touch.clientX === 'number' && typeof touch.clientY === 'number') {
        return { x: touch.clientX, y: touch.clientY, space: 'client' };
      }
      if (typeof touch.pageX === 'number' && typeof touch.pageY === 'number') {
        return { x: touch.pageX, y: touch.pageY, space: 'page' };
      }
    }

    var detail = event && event.detail || {};
    if (typeof detail.clientX === 'number' && typeof detail.clientY === 'number') {
      return { x: detail.clientX, y: detail.clientY, space: 'client' };
    }
    if (typeof detail.x === 'number' && typeof detail.y === 'number') {
      return { x: detail.x, y: detail.y, space: 'page' };
    }
    if (typeof detail.pageX === 'number' && typeof detail.pageY === 'number') {
      return { x: detail.pageX, y: detail.pageY, space: 'page' };
    }

    return null;
  }

  // 浅快照 hover 事件里会用到的字段，供节流尾事件补发时重放
  function snapshotHoverEvent(event) {
    event = event || {};
    return {
      detail: event.detail,
      touches: event.touches,
      changedTouches: event.changedTouches,
      target: event.target,
      currentTarget: event.currentTarget,
      timeStamp: event.timeStamp
    };
  }

  function toViewportPoint(context, point) {
    if (!point || point.space !== 'page') return point;

    var scroll = context && context.__mpCodeInspectorScroll || null;
    return {
      x: point.x - (scroll && scroll.left || 0),
      y: point.y - (scroll && scroll.top || 0),
      space: 'client'
    };
  }

  function isPointInRect(point, rect) {
    return point &&
      rect &&
      typeof rect.left === 'number' &&
      typeof rect.top === 'number' &&
      typeof rect.width === 'number' &&
      typeof rect.height === 'number' &&
      point.x >= rect.left &&
      point.x <= rect.left + rect.width &&
      point.y >= rect.top &&
      point.y <= rect.top + rect.height;
  }

  function getRectArea(rect) {
    return Math.max(0, rect.width || 0) * Math.max(0, rect.height || 0);
  }

  // 近乎铺满视口的矩形（页面根容器）不参与高亮，避免鼠标停在空白处时整页闪烁
  function isNearFullscreenRect(rect) {
    return !!windowSize &&
      windowSize.width > 0 &&
      windowSize.height > 0 &&
      rect.width >= windowSize.width * 0.98 &&
      rect.height >= windowSize.height * 0.95;
  }

  function findHitRect(rects, point) {
    var hit = null;
    var hitArea = Infinity;

    for (var index = 0; index < rects.length; index += 1) {
      var rect = rects[index];
      var area = getRectArea(rect);
      if (area <= 0 || isNearFullscreenRect(rect) || !isPointInRect(point, rect)) continue;

      if (!hit || area <= hitArea) {
        hit = rect;
        hitArea = area;
      }
    }

    return hit;
  }

  function renderOverlay(context, rect, dataset) {
    if (!rect || !context || typeof context.setData !== 'function' || context.__mpCodeInspectorDestroyed) return;

    // 跨上下文仲裁：同一次指针位置（时间窗内）多个上下文竞争时，矩形更小（更具体）者胜出；
    // 窗口过期后视为指针已移动，直接替换旧框。全局任意时刻最多一个高亮框。
    var area = getRectArea(rect);
    var now = Date.now();
    if (currentOverlay.context && currentOverlay.context !== context) {
      if (
        currentOverlay.context.__mpCodeInspectorOverlayVisible &&
        now - currentOverlay.at < config.overlayArbitrationMs &&
        currentOverlay.area <= area
      ) {
        return;
      }
      hideOverlay(currentOverlay.context);
    }
    currentOverlay = { context: context, area: area, at: now };

    var resolvedDataset = rect.dataset || dataset || {};
    var codeId = resolvedDataset.codeId || '';
    var codeLoc = resolvedDataset.codeLoc || '';
    var style = buildOverlayStyle(rect);
    var overlayKey = codeId + ':' + codeLoc + ':' + style;

    cancelScheduledHide(context);
    if (context.__mpCodeInspectorLastOverlayKey === overlayKey) return;

    context.__mpCodeInspectorLastOverlayKey = overlayKey;
    context.__mpCodeInspectorOverlayVisible = true;
    context.__mpCodeInspectorHoverDataset = resolvedDataset;
    context.__mpCodeInspectorLastHitRect = rect;
    debug.renders += 1;
    if (overlayContexts.indexOf(context) === -1) overlayContexts.push(context);

    var showLabel = config.overlayLabel === true && !!codeLoc;
    context.setData({
      __mpCodeInspectorOverlay: {
        visible: true,
        style: style,
        label: showLabel ? codeLoc : '',
        labelStyle: showLabel ? buildLabelStyle(rect) : ''
      }
    });
  }

  function renderHitFromRects(context, point) {
    var rects = context && context.__mpCodeInspectorRects || [];
    var hit = findHitRect(rects, toViewportPoint(context, point));

    if (hit) {
      renderOverlay(context, hit);
      return;
    }

    scheduleHide(context);
  }

  function refreshRectCache(context, point) {
    if (!context || context.__mpCodeInspectorDestroyed) return;
    if (context.__mpCodeInspectorRectPending) {
      // 页面切换等场景下 selectorQuery 回调可能永远不回来，超时后允许重发，
      // 否则该页面的 hover 会一直卡在旧缓存上（"切页后迟钝"）
      if (Date.now() - (context.__mpCodeInspectorRectPendingAt || 0) < config.rectPendingTimeoutMs) return;
    }

    context.__mpCodeInspectorRectPending = true;
    context.__mpCodeInspectorRectPendingAt = Date.now();
    context.__mpCodeInspectorLastPoint = point;
    context.__mpCodeInspectorLastPointAt = Date.now();

    var query = wxApi.createSelectorQuery();
    if (query && typeof query.in === 'function') query = query.in(context);
    query.selectAll('.mpcts-target').boundingClientRect();
    var hasViewport = typeof query.selectViewport === 'function';
    if (hasViewport) {
      // 个别基础库版本对 in() 作用域下的 selectViewport 支持存疑，失败时退化为不取滚动偏移
      try {
        query.selectViewport().scrollOffset();
      } catch (viewportError) {
        hasViewport = false;
      }
    }

    try {
      query.exec(function onRects(res) {
        context.__mpCodeInspectorRectPending = false;
        if (context.__mpCodeInspectorDestroyed) return;

        var rects = res && res[0];
        context.__mpCodeInspectorRects = Array.isArray(rects) ? rects : [];
        context.__mpCodeInspectorRectsAt = Date.now();
        debug.lastRectCount = context.__mpCodeInspectorRects.length;

        var scroll = hasViewport ? res && res[1] : null;
        if (scroll) {
          context.__mpCodeInspectorScroll = {
            top: scroll.scrollTop || 0,
            left: scroll.scrollLeft || 0
          };
        }

        renderHitFromRects(context, context.__mpCodeInspectorLastPoint || point);
      });
    } catch (execError) {
      context.__mpCodeInspectorRectPending = false;
      debug.lastError = String(execError && execError.message || execError);
    }
  }

  function showOverlay(event, context) {
    if (config.hover === false) return;

    context = context || this;
    if (!context || typeof context.setData !== 'function' || context.__mpCodeInspectorDestroyed) return;

    if (!state.modifierActive) {
      if (context.__mpCodeInspectorOverlayVisible) hideOverlay(context);
      return;
    }

    debug.hoverEvents += 1;

    var now = Date.now();
    var sinceLast = now - (context.__mpCodeInspectorLastHoverAt || 0);
    if (sinceLast < config.hoverThrottleMs) {
      // 尾事件补发：mouseover 是离散事件流（不按键时没有后续 mousemove 兜底），
      // 直接丢弃会导致最后停留的元素永远不高亮（"不跟手"）。
      context.__mpCodeInspectorPendingHover = snapshotHoverEvent(event);
      if (!context.__mpCodeInspectorTrailingTimer) {
        context.__mpCodeInspectorTrailingTimer = schedule(function () {
          context.__mpCodeInspectorTrailingTimer = null;
          var pending = context.__mpCodeInspectorPendingHover;
          context.__mpCodeInspectorPendingHover = null;
          if (pending && state.modifierActive && !context.__mpCodeInspectorDestroyed) {
            context.__mpCodeInspectorLastHoverAt = 0;
            showOverlay(pending, context);
          }
        }, config.hoverThrottleMs - sinceLast + 1);
      }
      return;
    }
    context.__mpCodeInspectorLastHoverAt = now;

    var point = getPointerPoint(event);
    debug.lastPoint = point;
    if (point) {
      context.__mpCodeInspectorLastPoint = point;
      context.__mpCodeInspectorLastPointAt = Date.now();

      if (
        context.__mpCodeInspectorRects &&
        now - (context.__mpCodeInspectorRectsAt || 0) < config.rectCacheTtl
      ) {
        renderHitFromRects(context, point);
      } else {
        refreshRectCache(context, point);
      }
      return;
    }

    // 拿不到指针坐标时退化为按事件目标的 codeId 高亮单个元素
    var codeIds = getCodeIdCandidates(event);
    if (!codeIds.length) return;

    var selectors = [];
    var datasets = [];
    for (var index = 0; index < codeIds.length; index += 1) {
      var dataset = index === 0
        ? (event && event.target && event.target.dataset || {})
        : (event && event.currentTarget && event.currentTarget.dataset || {});
      selectors.push('.' + codeIds[index]);
      datasets.push(dataset);
      selectors.push('[data-code-id="' + codeIds[index] + '"]');
      datasets.push(dataset);
    }

    function selectNext(selectorIndex) {
      if (selectorIndex >= selectors.length || context.__mpCodeInspectorDestroyed) return;

      wxApi.createSelectorQuery()
        .in(context)
        .select(selectors[selectorIndex])
        .boundingClientRect(function onRect(rect) {
          if (rect) {
            renderOverlay(context, rect, datasets[selectorIndex]);
            return;
          }

          selectNext(selectorIndex + 1);
        })
        .exec();
    }

    selectNext(0);
  }

  function openHoveredSource(event, context) {
    var dataset = context && context.__mpCodeInspectorHoverDataset;
    if (!dataset || !dataset.codeLoc) return;

    openSource.call(context, {
      timeStamp: event && event.timeStamp || Date.now(),
      target: { dataset: dataset },
      currentTarget: { dataset: dataset }
    }, { context: context });
  }

  // ---------------------------------------------------------------------------
  // 页面/组件生命周期与缓存管理
  // ---------------------------------------------------------------------------

  function registerPageContext(context) {
    if (!context || context.__mpCodeInspectorDestroyed) return;
    if (pageContexts.indexOf(context) === -1) pageContexts.push(context);
    // 页面重新显示时布局可能已变化，强制下一次 hover 重新取矩形
    context.__mpCodeInspectorRectsAt = 0;
    context.__mpCodeInspectorRectPending = false;
    // 同步修饰键状态（页面在按住修饰键期间出现/恢复，或隐藏期间状态已翻转）
    if (state.modifierActive || context.__mpCodeInspectorActiveFlag !== undefined) {
      setContextActive(context, state.modifierActive);
    }
  }

  function unregisterPageContext(context) {
    removeFromList(pageContexts, context);
    if (context) hideOverlay(context);
  }

  function cleanupContext(context) {
    if (!context) return;

    cancelScheduledHide(context);
    if (context.__mpCodeInspectorTrailingTimer) {
      clearTimeout(context.__mpCodeInspectorTrailingTimer);
      context.__mpCodeInspectorTrailingTimer = null;
    }
    context.__mpCodeInspectorPendingHover = null;
    removeFromList(pageContexts, context);
    removeFromList(overlayContexts, context);
    context.__mpCodeInspectorDestroyed = true;
    context.__mpCodeInspectorRects = null;
    context.__mpCodeInspectorRectsAt = 0;
    context.__mpCodeInspectorRectPending = false;
    context.__mpCodeInspectorScroll = null;
    context.__mpCodeInspectorHoverDataset = null;
    context.__mpCodeInspectorOverlayVisible = false;
    context.__mpCodeInspectorLastHoverAt = 0;
    context.__mpCodeInspectorLastOverlayKey = '';
    context.__mpCodeInspectorLastPoint = null;
    context.__mpCodeInspectorLastPointAt = 0;
    context.__mpCodeInspectorLastHitRect = null;
    context.__mpCodeInspectorActiveFlag = undefined;
  }

  function handlePageScroll(context, event) {
    if (!context || context.__mpCodeInspectorDestroyed) return;

    var scroll = context.__mpCodeInspectorScroll || (context.__mpCodeInspectorScroll = { top: 0, left: 0 });
    if (event && typeof event.scrollTop === 'number') scroll.top = event.scrollTop;
    // 视口坐标随滚动整体位移，缓存的矩形立即作废；
    // 边框立即隐藏（不能走延迟隐藏——其"指针仍在框内"守卫用的是已失效的旧矩形），
    // 滚动停止后下一个 hover 事件会用新矩形重新吸附，避免边框跟着滚动漂移
    context.__mpCodeInspectorRectsAt = 0;
    if (context.__mpCodeInspectorOverlayVisible) hideOverlay(context);
  }

  function invalidateRectCaches() {
    var contexts = pageContexts.concat(overlayContexts);
    for (var index = 0; index < contexts.length; index += 1) {
      if (contexts[index]) contexts[index].__mpCodeInspectorRectsAt = 0;
    }
  }

  if (typeof wxApi.onWindowResize === 'function') {
    wxApi.onWindowResize(invalidateRectCaches);
  }

  function wrapPageLifecycle(options, name, before, after) {
    var original = options[name];

    options[name] = function wrappedPageLifecycle() {
      if (typeof before === 'function') before(this);

      var result;
      if (typeof original === 'function') {
        result = original.apply(this, arguments);
      }

      if (typeof after === 'function') after(this);
      return result;
    };
  }

  function wrapPageScroll(options) {
    var original = options.onPageScroll;

    options.onPageScroll = function wrappedPageScroll(event) {
      handlePageScroll(this, event);
      if (typeof original === 'function') return original.apply(this, arguments);
    };
  }

  // lifetimes.detached 的优先级高于顶层 detached，只包装原本存在的那个槽位，
  // 避免新建 lifetimes.detached 把 uni-app 的 legacy detached 屏蔽掉
  function wrapComponentDetached(options) {
    if (options.lifetimes && typeof options.lifetimes.detached === 'function') {
      var originalDetached = options.lifetimes.detached;
      options.lifetimes.detached = function wrappedDetached() {
        cleanupContext(this);
        return originalDetached.apply(this, arguments);
      };
      return;
    }

    var legacyDetached = options.detached;
    options.detached = function wrappedLegacyDetached() {
      cleanupContext(this);
      if (typeof legacyDetached === 'function') return legacyDetached.apply(this, arguments);
    };
  }

  // ---------------------------------------------------------------------------
  // 点击跳转
  // ---------------------------------------------------------------------------

  function replayTap(context, event, originalTap) {
    if (!originalTap || !context) return;

    var handler = context[originalTap];
    if (typeof handler === 'function') {
      handler.call(context, event);
      return;
    }

    var vmHandler = context.$vm && context.$vm[originalTap];
    if (typeof vmHandler === 'function') {
      vmHandler.call(context.$vm, event);
    }
  }

  function openSource(event, options) {
    options = options || {};
    if (!isEnabled()) return;

    var dataset = getDataset(event);
    var currentDataset = getCurrentDataset(event);
    var loc = dataset.codeLoc;
    var originalTap = currentDataset.codeOriginalTap || dataset.codeOriginalTap;
    if (!loc) return;

    var timestamp = event && event.timeStamp ? event.timeStamp : Date.now();
    var requestKey = loc + ':' + timestamp + ':' + (options.catchTap ? 'catch' : 'bind');
    var now = Date.now();
    if (requestKey === lastRequestKey && now - lastRequestAt < 500) return;

    lastRequestKey = requestKey;
    lastRequestAt = now;

    wxApi.request({
      url: baseUrl + '/open?loc=' + encodeURIComponent(loc),
      method: 'GET',
      success: function success(res) {
        var data = res && res.data || {};
        if (data.handled === true && options.context) {
          hideOverlay(options.context);
        }
        if (options.replayOnIgnored && data.handled !== true) {
          replayTap(options.context, event, originalTap);
        }
      },
      fail: function fail(error) {
        if (options.replayOnIgnored) {
          replayTap(options.context, event, originalTap);
        }
        if (typeof console !== 'undefined') {
          console.warn('[mp-click-to-source] open failed:', error);
        }
      }
    });
  }

  // ---------------------------------------------------------------------------
  // patch Page / Component
  // ---------------------------------------------------------------------------

  function buildInspectorMethods() {
    return {
      __mpCodeInspectorTap: function __mpCodeInspectorTap(event) {
        return openSource.call(this, event, { context: this });
      },
      __mpCodeInspectorTapCatch: function __mpCodeInspectorTapCatch(event) {
        return openSource.call(this, event, {
          catchTap: true,
          context: this,
          replayOnIgnored: true
        });
      },
      __mpCodeInspectorLongPress: function __mpCodeInspectorLongPress(event) {
        return openSource.call(this, event, { context: this });
      },
      __mpCodeInspectorHover: function __mpCodeInspectorHover(event) {
        return showOverlay.call(this, event, this);
      },
      __mpCodeInspectorPointerMove: function __mpCodeInspectorPointerMove(event) {
        return showOverlay.call(this, event, this);
      },
      __mpCodeInspectorPointerTap: function __mpCodeInspectorPointerTap(event) {
        return openHoveredSource(event, this);
      },
      __mpCodeInspectorLeave: function __mpCodeInspectorLeave() {
        return scheduleHide(this);
      },
      __mpCodeInspectorStop: function __mpCodeInspectorStop() {}
    };
  }

  function wrapPageLifecycles(target) {
    wrapPageLifecycle(target, 'onLoad', registerPageContext);
    wrapPageLifecycle(target, 'onShow', registerPageContext);
    wrapPageLifecycle(target, 'onHide', null, unregisterPageContext);
    wrapPageLifecycle(target, 'onUnload', null, cleanupContext);
    wrapPageScroll(target);
  }

  function patchPage(originalPage) {
    return function patchedPage(options) {
      options = options || {};
      Object.assign(options, buildInspectorMethods());
      wrapPageLifecycles(options);
      return originalPage(options);
    };
  }

  function patchComponent(originalComponent) {
    return function patchedComponent(options) {
      options = options || {};
      options.methods = options.methods || {};
      Object.assign(options.methods, buildInspectorMethods());
      // uni-app 等框架用 Component() 注册页面，页面生命周期（onLoad/onShow/onPageScroll...）
      // 挂在 methods 上；对非页面组件这些方法不会被调用，注入无副作用
      wrapPageLifecycles(options.methods);
      wrapComponentDetached(options);
      return originalComponent(options);
    };
  }

  // 诊断 API 最先挂载：即使后续 patch 在特殊环境下失败，也能用 getDebugInfo 定位
  wxApi.__mpClickToSource = {
    enable: function enable() {
      setEnabled(true);
    },
    disable: function disable() {
      setEnabled(false);
    },
    toggle: function toggle() {
      setEnabled(!isEnabled());
    },
    isEnabled: isEnabled,
    isModifierActive: function isModifierActive() {
      return state.modifierActive;
    },
    isServerOnline: function isServerOnline() {
      return state.serverOnline;
    },
    getDebugInfo: function getDebugInfo() {
      return {
        serverOnline: state.serverOnline,
        modifierActive: state.modifierActive,
        hoverEvents: debug.hoverEvents,
        renders: debug.renders,
        lastPoint: debug.lastPoint,
        lastRectCount: debug.lastRectCount,
        lastError: debug.lastError,
        pageContexts: pageContexts.length,
        overlayContexts: overlayContexts.length
      };
    },
    __requestModifierState: function __requestModifierState() {
      requestModifierState(0);
    }
  };

  try {
    if (typeof Page === 'function') Page = patchPage(Page);
    if (typeof Component === 'function') Component = patchComponent(Component);
  } catch (patchError) {
    debug.lastError = 'patch failed: ' + (patchError && patchError.message || patchError);
    if (typeof console !== 'undefined') {
      console.warn('[mp-click-to-source] Page/Component patch failed:', patchError);
    }
  }

  startModifierSync();

  if (typeof console !== 'undefined') {
    console.info('[mp-click-to-source] installed, option-click inspector is ready');
  }
}

module.exports = {
  installMpClickToSource: installMpClickToSource
};
