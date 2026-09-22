// Browser half of the transparency spike — hand-written module-table bundle
// (same shape tsdown emits: __ModuleLoader__.load + CJS factory). Registers a
// right-Sidebar tab type whose body is an iframe to the plugin's own channel
// page at 127.0.0.1:4173 — the channel runs inside the dsh process, so the
// embedded page reads live session state with zero extra transport.
window.__ModuleLoader__.load({
  id: 'dsh-transparency',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })
    const React = require('react')
    const e = React.createElement

    const ID = 'dsh-transparency'

    function EyeGlyph({ size = 14, className }) {
      return e('span', { className, style: { fontSize: size, lineHeight: 1 } }, '◉')
    }

    function definition() {
      return {
        id: ID,
        kind: 'transparency',
        priority: 'builtin',
        title: () => 'ctx',
        guide: [{
          id: 'transparency',
          order: 10,
          title: () => 'ctx panel',
          description: () => 'transparent context editor (spike)',
          icon: EyeGlyph,
        }],
      }
    }

    function TransparencyBody(props) {
      // 座位是 session 作用域：当前会话 id 经标准 prop 传入，切会话即换面板目标
      const sid = props?.sessionId
      const src = sid === undefined || sid === null
        ? 'http://127.0.0.1:4173/'
        : `http://127.0.0.1:4173/?session=${encodeURIComponent(String(sid))}`
      return e('iframe', {
        src,
        title: 'dsh-ctx',
        style: { width: '100%', height: '100%', border: 0, display: 'block', background: '#14161a' },
      })
    }

    function TransparencyTitle() {
      return e(React.Fragment, null, 'ctx')
    }

    exports.name = 'dsh-transparency-client'
    exports.inject = ['slots', 'sidebarRightTabs']
    exports.apply = function apply(ctx) {
      ctx.effect(() => ctx.sidebarRightTabs.register(definition()), 'transparency: tab type')
      ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register(
        { name: 'sidebar.right.pane.tab', key: ID }, TransparencyBody,
      )), 'transparency: tab body')
      ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab.title', () => ctx.slots.register(
        { name: 'sidebar.right.pane.tab.title', key: ID }, TransparencyTitle,
      )), 'transparency: tab title')
    }
    return module.exports
  },
})
