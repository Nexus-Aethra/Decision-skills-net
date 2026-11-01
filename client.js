/**
 * decision-skills 浏览器半边：设置里的「技能」分区。
 *
 * 模块契约（照 `@local/dsh-paper-fetch` 已验证的写法）：
 *   window.__ModuleLoader__.load({ id, factory(require) { return { apply(ctx) } } })
 * React 只能从 factory 的 `require('react')` 拿——顶层没有 require。
 *
 * 两条来自官方文档的硬约束：
 * - 不 import 任何 Harness Client 包（ui-primitives 等）：它们随时会变，
 *   且组件一崩整个插槽会被清空。这里只借用宿主主题变量 `--dsw-alias-*`。
 * - 所有注册挂在 apply 的 ctx 上，返回清理函数。
 */
window.__ModuleLoader__.load({
  id: '@local/decision-skills',

  factory(require) {
    const React = require('react')
    const { useEffect, useMemo, useRef, useState } = React

    /** Remote 方法清单：必须与宿主 installSkillManager 的 methods 逐项一致。 */
    const REMOTE_METHODS = ['list', 'read', 'setEnabled']
    const NS = 'skillManager'
    const LOCALE_NS = 'decisionSkills'
    const SECTION_ID = 'decision-skills'
    const SLOT = 'settings.section'
    const PASS_THROUGH = () => ({ parse: (value) => value })

    /** 手写 typert 贡献描述；外部包走不到生成流水线。 */
    const TYPERT_REMOTE = {
      package: '@local/decision-skills',
      descriptors: REMOTE_METHODS.map((method) => ({
        id: '@local/decision-skills#' + NS + '/' + method,
        service: NS,
        namespace: NS,
        method,
        invocation: { kind: 'direct' },
        parameters: [{
          name: 'request',
          wire: 'request',
          source: 'json',
          codec: {
            mode: 'strict',
            typeSymbol: '@local/decision-skills#' + NS + '/' + method + ':request',
            create: PASS_THROUGH,
          },
        }],
      })),
    }

    const zh = {
      meta: { title: '技能管理', description: '浏览系统级与所有工作区的技能，并切换启用状态。' },
      nav: '技能', title: '技能管理',
      subtitle: '系统级与所有工作区的 SKILL.md',
      refresh: '刷新', search: '搜索名称或描述',
      filterAll: '全部', filterEnabled: '已启用', filterDisabled: '已关闭',
      scopeSystem: '系统级', scopeProject: '工作区',
      countSkills: '个技能', countEnabled: '已启用', countDisabled: '已关闭',
      empty: '这个范围里还没有技能。在 <工作区>/.agents/skills/<名字>/SKILL.md 新建即可。',
      loading: '正在读取…', error: '读取失败', retry: '重试',
      preview: '预览', close: '收起',
      noDescription: '（没有描述）', rootMissing: '目录不存在',
      unreachable: '端点不可达', switchedOn: '已启用', switchedOff: '已关闭',
    }
    const en = {
      meta: { title: 'Skill Manager', description: 'Browse system-level and workspace skills, and toggle them.' },
      nav: 'Skills', title: 'Skill Manager',
      subtitle: 'SKILL.md across the system root and every workspace',
      refresh: 'Refresh', search: 'Search name or description',
      filterAll: 'All', filterEnabled: 'Enabled', filterDisabled: 'Disabled',
      scopeSystem: 'System', scopeProject: 'Workspace',
      countSkills: 'skills', countEnabled: 'enabled', countDisabled: 'disabled',
      empty: 'No skills yet. Create one at <workspace>/.agents/skills/<name>/SKILL.md.',
      loading: 'Loading…', error: 'Failed to load', retry: 'Retry',
      preview: 'Preview', close: 'Collapse',
      noDescription: '(no description)', rootMissing: 'Directory missing',
      unreachable: 'Endpoint unreachable', switchedOn: 'Enabled', switchedOff: 'Disabled',
    }

    const styles = {
      wrap: { display: 'flex', flexDirection: 'column', gap: 12, width: '100%', maxWidth: 760 },
      header: { display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' },
      title: { fontSize: 15, fontWeight: 600, color: 'var(--dsw-alias-label-primary)' },
      subtitle: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)' },
      toolbar: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' },
      input: {
        flex: '1 1 180px', minWidth: 140, padding: '6px 10px', fontSize: 13,
        color: 'var(--dsw-alias-label-primary)', background: 'var(--dsw-alias-bg-secondary)',
        border: '1px solid var(--dsw-alias-border-secondary)', borderRadius: 6, outline: 'none',
      },
      btn: {
        padding: '6px 12px', fontSize: 12, cursor: 'pointer', borderRadius: 6,
        color: 'var(--dsw-alias-label-primary)', background: 'transparent',
        border: '1px solid var(--dsw-alias-border-secondary)',
      },
      btnOn: {
        padding: '6px 12px', fontSize: 12, cursor: 'pointer', borderRadius: 6,
        color: 'var(--dsw-alias-label-primary)', background: 'var(--dsw-alias-bg-secondary)',
        border: '1px solid var(--dsw-alias-label-primary)',
      },
      group: { display: 'flex', flexDirection: 'column', gap: 6 },
      groupHead: {
        display: 'flex', alignItems: 'center', gap: 8, fontSize: 12,
        color: 'var(--dsw-alias-label-secondary)', marginTop: 2,
      },
      row: {
        display: 'flex', alignItems: 'flex-start', gap: 10, padding: '9px 11px',
        border: '1px solid var(--dsw-alias-border-secondary)', borderRadius: 8,
        background: 'var(--dsw-alias-bg-secondary)',
      },
      rowMain: { display: 'flex', flexDirection: 'column', gap: 3, flex: 1, minWidth: 0 },
      skillName: { fontSize: 13, fontWeight: 600, color: 'var(--dsw-alias-label-primary)' },
      skillDesc: {
        fontSize: 12, color: 'var(--dsw-alias-label-secondary)', lineHeight: 1.45,
        overflow: 'hidden', textOverflow: 'ellipsis', display: '-webkit-box',
        WebkitLineClamp: 2, WebkitBoxOrient: 'vertical',
      },
      path: { fontSize: 11, color: 'var(--dsw-alias-label-tertiary)', wordBreak: 'break-all' },
      badge: {
        fontSize: 10, padding: '1px 6px', borderRadius: 999, flex: '0 0 auto',
        color: 'var(--dsw-alias-label-secondary)',
        border: '1px solid var(--dsw-alias-border-secondary)',
      },
      muted: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)', padding: '8px 0' },
      preview: {
        marginTop: 6, padding: 10, borderRadius: 6, maxHeight: 240, overflow: 'auto',
        background: 'var(--dsw-alias-bg-tertiary)', border: '1px solid var(--dsw-alias-border-secondary)',
        fontSize: 12, lineHeight: 1.55, whiteSpace: 'pre-wrap', wordBreak: 'break-word',
        color: 'var(--dsw-alias-label-primary)',
      },
      switchTrack: (on) => ({
        width: 34, height: 18, borderRadius: 9, border: 'none', cursor: 'pointer',
        padding: 0, position: 'relative', flex: '0 0 auto', marginTop: 3,
        background: on ? 'var(--dsw-alias-brand-primary)' : 'var(--dsw-alias-border-secondary)',
        transition: 'background 120ms ease',
      }),
      switchKnob: (on) => ({
        position: 'absolute', top: 2, left: on ? 18 : 2, width: 14, height: 14,
        borderRadius: '50%', background: '#fff', transition: 'left 120ms ease',
      }),
    }

    function el(tag, props, children) {
      return React.createElement(tag, props, children)
    }

    function Switch({ on, busy, onToggle, label }) {
      return el('button', {
        type: 'button', role: 'switch', 'aria-checked': on, 'aria-label': label,
        disabled: busy, onClick: onToggle,
        style: { ...styles.switchTrack(on), opacity: busy ? 0.6 : 1 },
      }, el('span', { style: styles.switchKnob(on) }))
    }

    function SkillRow({ skill, t, busy, onToggle, onPreview }) {
      return el('div', { style: styles.row }, [
        el('div', { key: 'main', style: styles.rowMain }, [
          el('div', { key: 'head', style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } }, [
            el('span', { key: 'n', style: styles.skillName }, skill.name),
            el('span', { key: 'b', style: styles.badge }, skill.rootKind),
          ]),
          el('div', { key: 'd', style: styles.skillDesc }, skill.description || t('noDescription')),
          el('div', { key: 'p', style: styles.path }, skill.file),
          el('div', { key: 'a', style: { marginTop: 2 } }, el('button', {
            type: 'button', style: { ...styles.btn, padding: '3px 9px', fontSize: 11 },
            onClick: onPreview,
          }, skill.previewOpen ? t('close') : t('preview'))),
          skill.previewOpen ? el('div', { key: 'pv', style: styles.preview }, skill.previewText ?? t('loading')) : null,
        ]),
        el(Switch, { key: 'sw', on: skill.enabled, busy, onToggle, label: skill.name }),
      ])
    }

    function SkillManagerSection(props) {
      const t = props.t
      const [state, setState] = useState({ status: 'loading', data: null, error: null })
      const [query, setQuery] = useState('')
      const [filter, setFilter] = useState('all')
      const [busy, setBusy] = useState({})
      const [preview, setPreview] = useState({})

      const call = async (method, request) => {
        const ns = props.namespace
        if (!ns || typeof ns[method] !== 'function') throw new Error(t('unreachable') + ': ' + NS + '/' + method)
        const envelope = await ns[method]({ request })
        if (envelope && typeof envelope === 'object' && 'ok' in envelope) {
          if (!envelope.ok) {
            const failure = envelope.error ?? {}
            throw new Error(failure.code || failure.message || 'remote failed')
          }
          return envelope.value
        }
        return envelope
      }

      const load = async () => {
        setState({ status: 'loading', data: null, error: null })
        try {
          setState({ status: 'ready', data: await call('list', {}), error: null })
        } catch (error) {
          setState({ status: 'error', data: null, error: String((error && error.message) || error) })
        }
      }

      useEffect(() => { void load() }, [])

      const toggle = async (skill) => {
        const key = skill.file
        setBusy((prev) => ({ ...prev, [key]: true }))
        try { await call('setEnabled', { file: skill.file, enabled: !skill.enabled }) } catch { /* 保留原状 */ }
        setBusy((prev) => ({ ...prev, [key]: false }))
        await load()
      }

      const openPreview = async (skill) => {
        const key = skill.file
        if (preview[key] && preview[key].open) {
          setPreview((prev) => ({ ...prev, [key]: { open: false } }))
          return
        }
        setPreview((prev) => ({ ...prev, [key]: { open: true, text: null } }))
        try {
          const result = await call('read', { file: skill.file })
          setPreview((prev) => ({ ...prev, [key]: { open: true, text: (result && result.content) || '' } }))
        } catch (error) {
          setPreview((prev) => ({ ...prev, [key]: { open: true, text: String((error && error.message) || error) } }))
        }
      }

      const view = useMemo(() => {
        if (!state.data) return null
        const q = query.trim().toLowerCase()
        const skills = state.data.skills
          .filter((s) => (filter === 'all' ? true : filter === 'enabled' ? s.enabled : !s.enabled))
          .filter((s) => q === '' || s.name.toLowerCase().includes(q)
            || String(s.description || '').toLowerCase().includes(q))
          .map((s) => (preview[s.file]
            ? { ...s, previewOpen: preview[s.file].open, previewText: preview[s.file].text }
            : s))
        const system = skills.filter((s) => s.scope === 'system')
        const map = new Map()
        for (const s of skills) {
          if (s.scope !== 'project') continue
          const key = s.projectPath || ''
          if (!map.has(key)) map.set(key, { title: s.projectTitle || key, skills: [] })
          map.get(key).skills.push(s)
        }
        return { system, projects: [...map.values()], shown: skills.length }
      }, [state, query, filter, preview])

      const total = state.data ? state.data.skills.length : 0
      const enabledCount = state.data ? state.data.skills.filter((s) => s.enabled).length : 0

      const children = [
        el('div', { key: 'h', style: styles.header }, [
          el('span', { key: 't', style: styles.title }, t('title')),
          el('span', { key: 's', style: styles.subtitle }, t('subtitle')),
        ]),
        el('div', { key: 'tb', style: styles.toolbar }, [
          el('input', {
            key: 'q', style: styles.input, value: query, placeholder: t('search'),
            onChange: (e) => setQuery(e.target.value),
          }),
          ...['all', 'enabled', 'disabled'].map((key) => el('button', {
            key: 'f' + key, type: 'button',
            style: filter === key ? styles.btnOn : styles.btn,
            onClick: () => setFilter(key),
          }, t(key === 'all' ? 'filterAll' : key === 'enabled' ? 'filterEnabled' : 'filterDisabled'))),
          el('button', { key: 'r', type: 'button', style: styles.btn, onClick: () => void load() }, t('refresh')),
        ]),
      ]

      if (state.status === 'loading') children.push(el('div', { key: 'ld', style: styles.muted }, t('loading')))
      if (state.status === 'error') {
        children.push(el('div', { key: 'er', style: styles.muted }, [
          t('error') + ': ' + state.error + ' ',
          el('button', { key: 'rt', type: 'button', style: styles.btn, onClick: () => void load() }, t('retry')),
        ]))
      }

      if (state.status === 'ready' && view) {
        children.push(el('div', { key: 'cnt', style: styles.subtitle },
          total + ' ' + t('countSkills') + ' · ' + enabledCount + ' ' + t('countEnabled')
          + ' · ' + (total - enabledCount) + ' ' + t('countDisabled')))

        if (total === 0) children.push(el('div', { key: 'em', style: styles.muted }, t('empty')))

        if (view.system.length > 0) {
          children.push(el('div', { key: 'gs', style: styles.group }, [
            el('div', { key: 'gh', style: styles.groupHead }, t('scopeSystem')),
            ...view.system.map((skill) => el(SkillRow, {
              key: skill.file, skill, t, busy: Boolean(busy[skill.file]),
              onToggle: () => void toggle(skill), onPreview: () => void openPreview(skill),
            })),
          ]))
        }

        view.projects.forEach((group, index) => {
          children.push(el('div', { key: 'gp' + index, style: styles.group }, [
            el('div', { key: 'gh', style: styles.groupHead }, t('scopeProject') + ' · ' + group.title),
            ...group.skills.map((skill) => el(SkillRow, {
              key: skill.file, skill, t, busy: Boolean(busy[skill.file]),
              onToggle: () => void toggle(skill), onPreview: () => void openPreview(skill),
            })),
          ]))
        })
      }

      return el('div', { style: styles.wrap }, children)
    }

    /** Remote 命名空间在异步握手后才有；用状态驱动重渲染。 */
    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(LOCALE_NS, { zh, en }), 'decision-skills: locales')
      const t = ctx.locale.bind(LOCALE_NS)

      const live = { namespace: null }
      const listeners = new Set()
      const setNamespace = (ns) => {
        live.namespace = ns
        for (const notify of listeners) notify()
      }
      const useNamespace = () => {
        const [, force] = useState(0)
        useEffect(() => {
          const notify = () => force((n) => n + 1)
          listeners.add(notify)
          return () => { listeners.delete(notify) }
        }, [])
        return live.namespace
      }

      const remote = ctx.remote
      if (remote && typeof remote.$mount === 'function') {
        const mounted = remote.$mount(TYPERT_REMOTE)
        const disposeRef = { current: null }
        if (mounted && typeof mounted.then === 'function') {
          void mounted.then(
            (disposer) => {
              disposeRef.current = typeof disposer === 'function' ? disposer : null
              setNamespace(remote[NS] ?? null)
            },
            () => { setNamespace(null) },
          )
          // 稳定引用包装：mount 是异步的，此刻 disposer 还是 null。
          ctx.effect(() => () => {
            if (disposeRef.current) disposeRef.current()
            disposeRef.current = null
          }, 'decision-skills: unmount remote')
        } else {
          setNamespace(remote[NS] ?? null)
        }
      }

      const Section = (props) => {
        const namespace = useNamespace()
        return el(SkillManagerSection, { ...props, t, namespace })
      }

      ctx.slots.inject(SLOT, () => ctx.slots.register({
        name: SLOT,
        id: SECTION_ID,
        order: 60,
        label: () => t('nav'),
        locale: LOCALE_NS,
        inject: () => ({}),
      }, Section))
    }

    return { apply }
  },
})
