const test = require('node:test');
const assert = require('node:assert/strict');
const { installMpClickToSource } = require('../runtime/miniprogram');

test('replays original tap when modifier server ignores the click', async () => {
  const requests = [];
  const originalPage = global.Page;
  const originalComponent = global.Component;
  const originalWx = global.wx;

  global.wx = {
    __mpClickToSourceInstalled: false,
    request(options) {
      requests.push(options.url);
      options.success({ data: { ok: true, handled: false, ignored: true } });
    },
    getStorageSync() {},
    setStorageSync() {}
  };
  global.Page = (options) => options;
  global.Component = (options) => options;

  try {
    installMpClickToSource({ trigger: 'option-click' });

    let replayed = 0;
    const page = Page({
      __e() {
        replayed += 1;
      }
    });

    page.__mpCodeInspectorTapCatch({
      timeStamp: 1,
      target: { dataset: { codeLoc: 'pages/demo.vue:2:3' } },
      currentTarget: { dataset: { codeOriginalTap: '__e' } }
    });

    assert.equal(replayed, 1);
    assert.equal(
      requests.find((url) => url.includes('/open?loc=')),
      'http://127.0.0.1:17365/open?loc=pages%2Fdemo.vue%3A2%3A3'
    );
  } finally {
    global.Page = originalPage;
    global.Component = originalComponent;
    global.wx = originalWx;
  }
});

test('does not replay original tap when modifier server handles the click', async () => {
  const originalPage = global.Page;
  const originalComponent = global.Component;
  const originalWx = global.wx;

  global.wx = {
    __mpClickToSourceInstalled: false,
    request(options) {
      options.success({ data: { ok: true, handled: true } });
    },
    getStorageSync() {},
    setStorageSync() {}
  };
  global.Page = (options) => options;
  global.Component = (options) => options;

  try {
    installMpClickToSource({ trigger: 'option-click' });

    let replayed = 0;
    const page = Page({
      __e() {
        replayed += 1;
      }
    });

    page.__mpCodeInspectorTapCatch({
      timeStamp: 1,
      target: { dataset: { codeLoc: 'pages/demo.vue:2:3' } },
      currentTarget: { dataset: { codeOriginalTap: '__e' } }
    });

    assert.equal(replayed, 0);
  } finally {
    global.Page = originalPage;
    global.Component = originalComponent;
    global.wx = originalWx;
  }
});

test('shows hover overlay by generated code-id class when modifier is active', () => {
  const originalPage = global.Page;
  const originalComponent = global.Component;
  const originalWx = global.wx;
  const selected = [];

  global.wx = {
    __mpClickToSourceInstalled: false,
    request(options) {
      if (options.url.includes('/modifier')) {
        options.success({ data: { ok: true, active: true } });
      }
    },
    createSelectorQuery() {
      return {
        in() {
          return this;
        },
        select(selector) {
          selected.push(selector);
          return this;
        },
        boundingClientRect(callback) {
          callback({ left: 10, top: 20, width: 30, height: 40 });
          return this;
        },
        exec() {}
      };
    },
    getStorageSync() {},
    setStorageSync() {}
  };
  global.Page = (options) => options;
  global.Component = (options) => options;

  try {
    installMpClickToSource({ trigger: 'option-click' });

    let data = null;
    const page = Page({
      setData(value) {
        data = value;
      }
    });

    page.__mpCodeInspectorHover({
      target: { dataset: { codeLoc: 'pages/demo.vue:2:3', codeId: 'mpcts_demo' } },
      currentTarget: { dataset: {} }
    });

    assert.equal(selected[0], '.mpcts_demo');
    assert.equal(data.__mpCodeInspectorOverlay.visible, true);
    assert.match(data.__mpCodeInspectorOverlay.style, /background-image:linear-gradient/);
    assert.match(data.__mpCodeInspectorOverlay.style, /#4285f4/);
    assert.match(data.__mpCodeInspectorOverlay.style, /#ea4335/);
    assert.match(data.__mpCodeInspectorOverlay.style, /#fbbc05/);
    assert.match(data.__mpCodeInspectorOverlay.style, /#34a853/);
    assert.match(data.__mpCodeInspectorOverlay.style, /border-radius:0px/);
    assert.match(data.__mpCodeInspectorOverlay.style, /background-size:100% 2px,100% 2px,2px 100%,2px 100%/);
    assert.match(data.__mpCodeInspectorOverlay.style, /box-shadow:none/);
    assert.doesNotMatch(data.__mpCodeInspectorOverlay.style, /0 0 8px/);
  } finally {
    global.Page = originalPage;
    global.Component = originalComponent;
    global.wx = originalWx;
  }
});

function createBatchQueryMock(selected, rects, scrollOffset) {
  return function createSelectorQuery() {
    return {
      in() {
        return this;
      },
      selectAll(selector) {
        selected.push(selector);
        return this;
      },
      boundingClientRect() {
        return this;
      },
      selectViewport() {
        return this;
      },
      scrollOffset() {
        return this;
      },
      exec(callback) {
        callback([rects, scrollOffset]);
      }
    };
  };
}

test('hit-tests the smallest rect under the pointer', () => {
  const originalPage = global.Page;
  const originalComponent = global.Component;
  const originalWx = global.wx;
  let modifierResponse = { ok: true, active: false };
  const selected = [];

  global.wx = {
    __mpClickToSourceInstalled: false,
    request(options) {
      if (options.url.includes('/modifier')) {
        options.success({ data: modifierResponse });
      }
    },
    createSelectorQuery: createBatchQueryMock(selected, [
      {
        left: 0,
        top: 0,
        width: 200,
        height: 120,
        dataset: { codeId: 'mpcts_outer', codeLoc: 'pages/demo.vue:1:1' }
      },
      {
        left: 20,
        top: 20,
        width: 80,
        height: 40,
        dataset: { codeId: 'mpcts_inner', codeLoc: 'pages/demo.vue:2:3' }
      }
    ], { scrollTop: 0, scrollLeft: 0 }),
    getStorageSync() {},
    setStorageSync() {}
  };
  global.Page = (options) => options;
  global.Component = (options) => options;

  try {
    installMpClickToSource({ trigger: 'option-click', hoverThrottleMs: 0, overlayLabel: true });

    const dataUpdates = [];
    const page = Page({
      setData(value) {
        dataUpdates.push(value);
      }
    });

    page.onLoad();
    modifierResponse = { ok: true, active: true };
    wx.__mpClickToSource.__requestModifierState();

    page.__mpCodeInspectorHover({
      detail: { x: 30, y: 30 },
      target: { dataset: {} },
      currentTarget: { dataset: {} }
    });

    assert.equal(selected[0], '.mpcts-target');
    assert.equal(page.__mpCodeInspectorHoverDataset.codeId, 'mpcts_inner');
    assert.equal(dataUpdates.at(-1).__mpCodeInspectorOverlay.visible, true);
    assert.equal(dataUpdates.at(-1).__mpCodeInspectorOverlay.label, 'pages/demo.vue:2:3');
  } finally {
    global.Page = originalPage;
    global.Component = originalComponent;
    global.wx = originalWx;
  }
});

test('compensates page-coordinate pointer events with the scroll offset', () => {
  const originalPage = global.Page;
  const originalComponent = global.Component;
  const originalWx = global.wx;
  const selected = [];

  global.wx = {
    __mpClickToSourceInstalled: false,
    request(options) {
      if (options.url.includes('/modifier')) {
        options.success({ data: { ok: true, active: true } });
      }
    },
    // 页面已滚动 100px：视口内矩形 top=20，页面坐标事件 y=130 应命中它
    createSelectorQuery: createBatchQueryMock(selected, [
      {
        left: 20,
        top: 20,
        width: 80,
        height: 40,
        dataset: { codeId: 'mpcts_scrolled', codeLoc: 'pages/demo.vue:9:5' }
      }
    ], { scrollTop: 100, scrollLeft: 0 }),
    getStorageSync() {},
    setStorageSync() {}
  };
  global.Page = (options) => options;
  global.Component = (options) => options;

  try {
    installMpClickToSource({ trigger: 'option-click', hoverThrottleMs: 0 });

    const dataUpdates = [];
    const page = Page({
      setData(value) {
        dataUpdates.push(value);
      }
    });

    page.onLoad();
    page.__mpCodeInspectorHover({
      detail: { x: 30, y: 130 },
      target: { dataset: {} },
      currentTarget: { dataset: {} }
    });

    assert.equal(page.__mpCodeInspectorHoverDataset.codeId, 'mpcts_scrolled');
    assert.equal(dataUpdates.at(-1).__mpCodeInspectorOverlay.visible, true);
  } finally {
    global.Page = originalPage;
    global.Component = originalComponent;
    global.wx = originalWx;
  }
});

test('supports uni-app style pages registered via Component and hides overlay on scroll', () => {
  const originalPage = global.Page;
  const originalComponent = global.Component;
  const originalWx = global.wx;
  const selected = [];

  global.wx = {
    __mpClickToSourceInstalled: false,
    request(options) {
      if (options.url.includes('/modifier')) {
        options.success({ data: { ok: true, active: true } });
      }
    },
    createSelectorQuery: createBatchQueryMock(selected, [
      {
        left: 10,
        top: 10,
        width: 80,
        height: 40,
        dataset: { codeId: 'mpcts_page', codeLoc: 'pages/demo.vue:5:3' }
      }
    ], { scrollTop: 0, scrollLeft: 0 }),
    getStorageSync() {},
    setStorageSync() {}
  };
  global.Page = (options) => options;
  global.Component = (options) => options;

  try {
    installMpClickToSource({ trigger: 'option-click', hoverThrottleMs: 0 });

    const dataUpdates = [];
    // uni-app 页面：生命周期挂在 methods 上，经 Component() 注册
    const options = Component({ methods: {} });
    const instance = Object.assign({
      setData(value) {
        dataUpdates.push(value);
      }
    }, options.methods);

    assert.equal(typeof options.methods.onPageScroll, 'function');
    assert.equal(typeof options.methods.onShow, 'function');

    instance.onLoad();
    // 修饰键激活状态广播到页面 data，驱动 WXML 的条件 catchtouchmove（滚动拦截）
    assert.ok(dataUpdates.some((value) => value.__mpCodeInspectorActive === true));

    instance.__mpCodeInspectorHover({
      detail: { x: 20, y: 20 },
      target: { dataset: {} },
      currentTarget: { dataset: {} }
    });
    assert.equal(dataUpdates.at(-1).__mpCodeInspectorOverlay.visible, true);

    instance.onPageScroll({ scrollTop: 120 });
    assert.equal(dataUpdates.at(-1).__mpCodeInspectorOverlay.visible, false);
    assert.equal(instance.__mpCodeInspectorScroll.top, 120);
    assert.equal(instance.__mpCodeInspectorRectsAt, 0);
  } finally {
    global.Page = originalPage;
    global.Component = originalComponent;
    global.wx = originalWx;
  }
});

test('uses long-poll parameters for modifier state sync', () => {
  const originalPage = global.Page;
  const originalComponent = global.Component;
  const originalWx = global.wx;
  const urls = [];

  global.wx = {
    __mpClickToSourceInstalled: false,
    request(options) {
      urls.push(options.url);
      options.success({ data: { ok: true, active: false } });
    },
    getStorageSync() {},
    setStorageSync() {}
  };
  global.Page = (options) => options;
  global.Component = (options) => options;

  try {
    installMpClickToSource({ trigger: 'option-click' });

    assert.ok(urls[0].includes('/modifier?wait=25000&known=0'));
  } finally {
    global.Page = originalPage;
    global.Component = originalComponent;
    global.wx = originalWx;
  }
});

test('falls back from hit target selector to current target selector', () => {
  const originalPage = global.Page;
  const originalComponent = global.Component;
  const originalWx = global.wx;
  const selected = [];

  global.wx = {
    __mpClickToSourceInstalled: false,
    request(options) {
      if (options.url.includes('/modifier')) {
        options.success({ data: { ok: true, active: true } });
      }
    },
    createSelectorQuery() {
      return {
        in() {
          return this;
        },
        select(selector) {
          selected.push(selector);
          this.selector = selector;
          return this;
        },
        boundingClientRect(callback) {
          callback(this.selector === '.mpcts_current'
            ? { left: 1, top: 2, width: 3, height: 4 }
            : null);
          return this;
        },
        exec() {}
      };
    },
    getStorageSync() {},
    setStorageSync() {}
  };
  global.Page = (options) => options;
  global.Component = (options) => options;

  try {
    installMpClickToSource({ trigger: 'option-click' });

    let data = null;
    const page = Page({
      setData(value) {
        data = value;
      }
    });

    page.__mpCodeInspectorHover({
      target: { dataset: { codeLoc: 'pages/demo.vue:2:3', codeId: 'mpcts_missing' } },
      currentTarget: { dataset: { codeLoc: 'pages/demo.vue:1:1', codeId: 'mpcts_current' } }
    });

    assert.deepEqual(selected, [
      '.mpcts_missing',
      '[data-code-id="mpcts_missing"]',
      '.mpcts_current'
    ]);
    assert.equal(data.__mpCodeInspectorOverlay.visible, true);
    assert.match(data.__mpCodeInspectorOverlay.style, /left:1px/);
  } finally {
    global.Page = originalPage;
    global.Component = originalComponent;
    global.wx = originalWx;
  }
});

test('keeps a single overlay across page and component contexts (smallest rect wins)', () => {
  const originalPage = global.Page;
  const originalComponent = global.Component;
  const originalWx = global.wx;

  // 页面上下文只能命中组件宿主的大矩形；组件上下文命中内部按钮的小矩形
  const rectsByContext = new Map();
  global.wx = {
    __mpClickToSourceInstalled: false,
    request(options) {
      if (options.url.includes('/modifier')) {
        options.success({ data: { ok: true, active: true } });
      }
    },
    createSelectorQuery() {
      return {
        _ctx: null,
        in(ctx) {
          this._ctx = ctx;
          return this;
        },
        selectAll() {
          return this;
        },
        boundingClientRect() {
          return this;
        },
        selectViewport() {
          return this;
        },
        scrollOffset() {
          return this;
        },
        exec(callback) {
          callback([rectsByContext.get(this._ctx) || [], { scrollTop: 0, scrollLeft: 0 }]);
        }
      };
    },
    getStorageSync() {},
    setStorageSync() {}
  };
  global.Page = (options) => options;
  global.Component = (options) => options;

  try {
    installMpClickToSource({ trigger: 'option-click', hoverThrottleMs: 0 });

    const pageUpdates = [];
    const page = Page({
      setData(value) {
        pageUpdates.push(value);
      }
    });
    const componentOptions = Component({ methods: {} });
    const componentUpdates = [];
    const component = Object.assign({
      setData(value) {
        componentUpdates.push(value);
      }
    }, componentOptions.methods);

    rectsByContext.set(page, [
      { left: 40, top: 300, width: 300, height: 350, dataset: { codeId: 'mpcts_host', codeLoc: 'pages/login.vue:8:3' } }
    ]);
    rectsByContext.set(component, [
      { left: 200, top: 560, width: 120, height: 40, dataset: { codeId: 'mpcts_btn', codeLoc: 'components/privacy.vue:20:5' } }
    ]);

    page.onLoad();

    // 同一指针位置：页面先渲染大框，组件随后渲染小框 => 页面框必须被裁掉
    page.__mpCodeInspectorHover({
      detail: { x: 240, y: 580 },
      target: { dataset: {} },
      currentTarget: { dataset: {} }
    });
    assert.equal(pageUpdates.at(-1).__mpCodeInspectorOverlay.visible, true);

    component.__mpCodeInspectorHover({
      detail: { x: 240, y: 580 },
      target: { dataset: {} },
      currentTarget: { dataset: {} }
    });
    assert.equal(componentUpdates.at(-1).__mpCodeInspectorOverlay.visible, true);
    assert.equal(pageUpdates.at(-1).__mpCodeInspectorOverlay.visible, false);

    // 紧接着页面上下文又渲染大框（同一轮竞争）=> 应被跳过，小框保持
    page.__mpCodeInspectorLastHoverAt = 0;
    page.__mpCodeInspectorHover({
      detail: { x: 240, y: 580 },
      target: { dataset: {} },
      currentTarget: { dataset: {} }
    });
    assert.equal(pageUpdates.at(-1).__mpCodeInspectorOverlay.visible, false);
    assert.equal(componentUpdates.at(-1).__mpCodeInspectorOverlay.visible, true);
  } finally {
    global.Page = originalPage;
    global.Component = originalComponent;
    global.wx = originalWx;
  }
});
