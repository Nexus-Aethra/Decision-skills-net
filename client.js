/**
 * decision-skills 浏览器半边：设置里的「技能」分区。
 *
 * 模块契约（照 @local/dsh-paper-fetch 已验证的写法）：
 *   window.__ModuleLoader__.load({ id, factory(require) { return { inject, apply } } })
 * React 只能从 factory 的 require('react') 拿。
 *
 * 硬约束：
 * - 不 import 任何 Harness Client 包；只借 --dsw-alias-* 主题变量。
 * - 顶层必须有 window 守卫：宿主 boot 审计只报 "failed"，不给原因。
 * - inject 必须是 factory 返回对象的属性，且**不能**声明自己要注册的
 *   'remote.<ns>'（会永远 pending）。
 */
;(function () {
  const DIAG = (phase, detail) => {
    try { console.error('[decision-skills] ' + phase + ': ' + detail) } catch { /* 没有 console */ }
  }

  if (typeof window === 'undefined' || !window.__ModuleLoader__) {
    DIAG('bootstrap', 'no __ModuleLoader__; skipping')
    return
  }

  const MODULE_ID = '@local/decision-skills'

  try {
    window.__ModuleLoader__.load({
      id: MODULE_ID,

      factory(require) {
        let React
        try {
          React = require('react')
        } catch (error) {
          DIAG('factory-react', String((error && error.message) || error))
          throw error
        }
        const { useEffect, useMemo, useState } = React

        const NS = 'skillManager'
        const LOCALE_NS = 'decisionSkills'
        const SECTION_ID = 'decision-skills'
        const SLOT = 'settings.section'
        const PASS_THROUGH = () => ({ parse: (value) => value })

        /**
         * 方法 -> wire 参数名。必须与宿主方法实参逐个对应：
         * 网关拿 descriptor.parameters 校验 args 字段集合，多一个就
         * 报 gateway/arguments-invalid。
         */
        const METHOD_PARAMS = {
          list: [],
          listForSession: ['request'],
          read: ['request'],
          setEnabled: ['request'],
        }
        const REMOTE_METHODS = Object.keys(METHOD_PARAMS)

        const TYPERT_REMOTE = {
          package: MODULE_ID,
          descriptors: REMOTE_METHODS.map((method) => ({
            id: MODULE_ID + '#' + NS + '/' + method,
            service: NS,
            namespace: NS,
            method,
            invocation: { kind: 'direct' },
            parameters: METHOD_PARAMS[method].map((name) => ({
              name,
              wire: name,
              source: 'json',
              codec: {
                mode: 'strict',
                typeSymbol: MODULE_ID + '#' + NS + '/' + method + ':' + name,
                create: PASS_THROUGH,
              },
            })),
            // result 不能省：网关 invoke() 直接读 descriptor.result.mode。
            result: {
              mode: 'strict',
              typeSymbol: MODULE_ID + '#' + NS + '/' + method + ':result',
              create: PASS_THROUGH,
            },
          })),
        }

        const zh = {
          meta: { title: '技能管理', description: '浏览内置、系统级与各工作区的技能，并切换启用状态。' },
          nav: '技能', title: '技能管理',
          subtitle: '内置、系统级与各工作区的 SKILL.md',
          refresh: '刷新', search: '搜索技能',
          filterAll: '全部', filterEnabled: '已启用', filterDisabled: '已关闭',
          scopeBundled: '内置', scopeSystem: '系统级', scopeProject: '工作区',
          countSkills: '个技能', countEnabled: '已启用', countDisabled: '已关闭',
          empty: '还没有发现技能。在 <工作区>/.agents/skills/<名字>/SKILL.md 新建即可。',
          emptyFiltered: '没有符合条件的技能。',
          loading: '正在读取…', error: '读取失败', retry: '重试',
          preview: '预览', collapse: '收起',
          noDescription: '（没有描述）',
          bundledHint: '内置技能随宿主发布，不可修改',
          unreachable: '端点不可达',
          scoped: '当前会话', global: '全部',
          sessionHint: '按会话隔离后，每个会话只看到自己作用域内的技能',
        }
        const en = {
          meta: { title: 'Skill Manager', description: 'Browse bundled, system and workspace skills, and toggle them.' },
          nav: 'Skills', title: 'Skill Manager',
          subtitle: 'SKILL.md across bundled, system and workspace roots',
          refresh: 'Refresh', search: 'Search skills',
          filterAll: 'All', filterEnabled: 'Enabled', filterDisabled: 'Disabled',
          scopeBundled: 'Bundled', scopeSystem: 'System', scopeProject: 'Workspace',
          countSkills: 'skills', countEnabled: 'enabled', countDisabled: 'disabled',
          empty: 'No skills found yet. Create one at <workspace>/.agents/skills/<name>/SKILL.md.',
          emptyFiltered: 'No skills match the filters.',
          loading: 'Loading…', error: 'Failed to load', retry: 'Retry',
          preview: 'Preview', collapse: 'Collapse',
          noDescription: '(no description)',
          bundledHint: 'Bundled skills ship with the host and are read-only',
          unreachable: 'Endpoint unreachable',
          scoped: 'This session', global: 'All',
          sessionHint: 'Scope the catalog to one session to give every session its own skill context',
        }

        /** 圆润、克制的视觉：大圆角 + 柔和分隔 + 明确的信息层级。 */
        const S = {
          wrap: { display: 'flex', flexDirection: 'column', gap: 16, width: '100%', maxWidth: 720 },
          head: { display: 'flex', flexDirection: 'column', gap: 4 },
          title: { fontSize: 16, fontWeight: 600, letterSpacing: '.01em', color: 'var(--dsw-alias-label-primary)' },
          subtitle: { fontSize: 12.5, lineHeight: 1.5, color: 'var(--dsw-alias-label-tertiary)' },

          toolbar: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' },
          search: {
            flex: '1 1 200px', minWidth: 160, height: 34, padding: '0 12px', fontSize: 13,
            color: 'var(--dsw-alias-label-primary)',
            background: 'var(--dsw-alias-bg-layer-1)',
            border: '1px solid var(--dsw-alias-border-l1)',
            borderRadius: 10, outline: 'none', boxSizing: 'border-box',
            transition: 'border-color 120ms ease',
          },
          segment: {
            display: 'inline-flex', gap: 2, padding: 3,
            background: 'var(--dsw-alias-bg-layer-1)',
            border: '1px solid var(--dsw-alias-border-l1)',
            borderRadius: 10,
          },
          segBtn: (on) => ({
            height: 26, padding: '0 11px', fontSize: 12, cursor: 'pointer',
            border: 'none', borderRadius: 7, background: on ? 'var(--dsw-alias-bg-layer-2)' : 'transparent',
            color: on ? 'var(--dsw-alias-label-primary)' : 'var(--dsw-alias-label-secondary)',
            boxShadow: on ? '0 1px 2px rgba(0,0,0,.06)' : 'none',
            transition: 'background 120ms ease, color 120ms ease',
          }),
          ghost: {
            height: 34, padding: '0 13px', fontSize: 12.5, cursor: 'pointer',
            color: 'var(--dsw-alias-label-secondary)',
            background: 'transparent',
            border: '1px solid var(--dsw-alias-border-l1)',
            borderRadius: 10, transition: 'background 120ms ease',
          },

          stats: { display: 'flex', gap: 14, alignItems: 'center', flexWrap: 'wrap' },
          stat: { display: 'flex', alignItems: 'baseline', gap: 5 },
          statNum: { fontSize: 13, fontWeight: 600, color: 'var(--dsw-alias-label-primary)' },
          statLabel: { fontSize: 12, color: 'var(--dsw-alias-label-tertiary)' },
          dot: { width: 3, height: 3, borderRadius: '50%', background: 'var(--dsw-alias-border-l3)' },

          group: { display: 'flex', flexDirection: 'column', gap: 8 },
          groupHead: {
            display: 'flex', alignItems: 'center', gap: 8,
            fontSize: 12, fontWeight: 600, letterSpacing: '.02em',
            color: 'var(--dsw-alias-label-tertiary)',
          },
          groupCount: {
            fontSize: 11, fontWeight: 500, padding: '1px 7px', borderRadius: 999,
            color: 'var(--dsw-alias-label-tertiary)',
            background: 'var(--dsw-alias-bg-layer-1)',
          },

          card: (readOnly) => ({
            display: 'flex', alignItems: 'flex-start', gap: 12, padding: '12px 14px',
            background: 'var(--dsw-alias-bg-layer-1)',
            border: '1px solid var(--dsw-alias-border-l1)',
            borderRadius: 14,
            transition: 'border-color 120ms ease, background 120ms ease',
            opacity: readOnly ? 0.92 : 1,
          }),
          cardMain: { display: 'flex', flexDirection: 'column', gap: 6, flex: 1, minWidth: 0 },
          nameRow: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
          name: { fontSize: 13.5, fontWeight: 600, color: 'var(--dsw-alias-label-primary)' },
          pill: {
            fontSize: 10.5, fontWeight: 500, padding: '2px 8px', borderRadius: 999,
            color: 'var(--dsw-alias-label-tertiary)',
            background: 'var(--dsw-alias-bg-layer-2)',
            border: '1px solid var(--dsw-alias-border-l1)',
          },
          desc: {
            fontSize: 12.5, lineHeight: 1.55, color: 'var(--dsw-alias-label-secondary)',
            overflow: 'hidden', textOverflow: 'ellipsis', display: '-webkit-box',
            WebkitLineClamp: 2, WebkitBoxOrient: 'vertical',
          },
          path: {
            fontSize: 11, lineHeight: 1.4, color: 'var(--dsw-alias-label-tertiary)',
            wordBreak: 'break-all', opacity: .85,
          },
          actions: { display: 'flex', alignItems: 'center', gap: 6, marginTop: 2 },
          tagBtn: {
            height: 24, padding: '0 10px', fontSize: 11.5, cursor: 'pointer',
            color: 'var(--dsw-alias-label-secondary)',
            background: 'transparent',
            border: '1px solid var(--dsw-alias-border-l1)',
            borderRadius: 8,
          },
          preview: {
            marginTop: 2, padding: '12px 14px', borderRadius: 12, maxHeight: 260, overflow: 'auto',
            background: 'var(--dsw-alias-bg-layer-2)',
            border: '1px solid var(--dsw-alias-border-l1)',
            fontSize: 12, lineHeight: 1.65, whiteSpace: 'pre-wrap', wordBreak: 'break-word',
            color: 'var(--dsw-alias-label-primary)',
          },

          switchTrack: (on, disabled) => ({
            width: 38, height: 22, borderRadius: 999, border: 'none',
            cursor: disabled ? 'not-allowed' : 'pointer', padding: 0,
            position: 'relative', flex: '0 0 auto', marginTop: 1,
            background: disabled
              ? 'var(--dsw-alias-bg-layer-2)'
              : (on ? 'var(--dsw-alias-state-business-primary)' : 'var(--dsw-alias-border-l3)'),
            opacity: disabled ? .5 : 1,
            transition: 'background 160ms ease',
          }),
          switchKnob: (on) => ({
            position: 'absolute', top: 3, left: on ? 19 : 3, width: 16, height: 16,
            borderRadius: '50%', background: '#fff',
            boxShadow: '0 1px 3px rgba(0,0,0,.18)',
            transition: 'left 160ms cubic-bezier(.4,0,.2,1)',
          }),

          muted: { fontSize: 12.5, color: 'var(--dsw-alias-label-tertiary)', padding: '6px 0' },
          panel: {
            padding: '14px 16px', borderRadius: 14,
            background: 'var(--dsw-alias-bg-layer-1)',
            border: '1px solid var(--dsw-alias-border-l1)',
            display: 'flex', flexDirection: 'column', gap: 10,
          },
          panelText: { fontSize: 12.5, lineHeight: 1.6, color: 'var(--dsw-alias-label-secondary)' },
        }

        const el = (tag, props, children) => React.createElement(tag, props, children)

        function Switch({ on, busy, disabled, onToggle, label }) {
          const blocked = busy || disabled
          return el('button', {
            type: 'button', role: 'switch', 'aria-checked': on, 'aria-label': label,
            'aria-disabled': disabled ? 'true' : 'false',
            disabled: blocked, onClick: onToggle,
            title: disabled ? undefined : undefined,
            style: S.switchTrack(on, disabled),
          }, el('span', { style: S.switchKnob(on) }))
        }

        function SkillCard({ skill, t, busy, onToggle, onPreview }) {
          const readOnly = skill.editable === false
          return el('div', { style: S.card(readOnly) }, [
            el('div', { key: 'm', style: S.cardMain }, [
              el('div', { key: 'n', style: S.nameRow }, [
                el('span', { key: 'nn', style: S.name }, skill.name),
                skill.source ? el('span', { key: 's', style: S.pill }, skill.source) : null,
                readOnly ? el('span', { key: 'ro', style: S.pill }, t('bundledHint')) : null,
              ]),
              el('div', { key: 'd', style: S.desc }, skill.description || t('noDescription')),
              skill.path ? el('div', { key: 'p', style: S.path }, skill.path) : null,
              el('div', { key: 'a', style: S.actions }, [
                el('button', {
                  key: 'pv', type: 'button', style: S.tagBtn, onClick: onPreview,
                }, skill.previewOpen ? t('collapse') : t('preview')),
              ]),
              skill.previewOpen
                ? el('div', { key: 'pv2', style: S.preview }, skill.previewText ?? t('loading'))
                : null,
            ]),
            el(Switch, {
              key: 'sw', on: skill.enabled, busy, disabled: readOnly,
              onToggle, label: skill.name,
            }),
          ])
        }

        function SkillManagerSection(props) {
          const t = props.t
          const [state, setState] = useState({ status: 'loading', data: null, error: null })
          const [query, setQuery] = useState('')
          const [filter, setFilter] = useState('all')
          const [scoped, setScoped] = useState(false)
          const [busy, setBusy] = useState({})
          const [preview, setPreview] = useState({})

          const call = async (method, request) => {
            const ns = props.namespace
            if (!ns || typeof ns[method] !== 'function') {
              throw new Error(t('unreachable') + ': ' + NS + '/' + method)
            }
            // 参数个数必须与描述符一致：无名方法传 {} 会被判 arguments-invalid。
            const envelope = request === undefined ? await ns[method]() : await ns[method](request)
            if (envelope && typeof envelope === 'object' && 'ok' in envelope) {
              if (!envelope.ok) {
                const failure = envelope.error ?? {}
                throw new Error(failure.code || failure.message || 'remote failed')
              }
              return envelope.value
            }
            return envelope
          }

          const load = async (useScope) => {
            setState({ status: 'loading', data: null, error: null })
            try {
              const wantScope = useScope ?? scoped
              const data = wantScope && props.sessionId
                ? await call('listForSession', { sessionId: props.sessionId })
                : await call('list')
              setState({ status: 'ready', data, error: null })
            } catch (error) {
              setState({ status: 'error', data: null, error: String((error && error.message) || error) })
            }
          }

          useEffect(() => { void load(false) }, [])

          const keyOf = (s) => s.path || s.name

          const toggle = async (skill) => {
            if (skill.editable === false) return
            const key = keyOf(skill)
            setBusy((prev) => ({ ...prev, [key]: true }))
            try {
              const outcome = await call('setEnabled', { file: skill.path, enabled: !skill.enabled })
              if (outcome && outcome.ok === false) DIAG('setEnabled', 'rejected: ' + String(outcome.error))
            } catch (error) {
              DIAG('setEnabled', String((error && error.message) || error))
            }
            setBusy((prev) => ({ ...prev, [key]: false }))
            await load()
          }

          const openPreview = async (skill) => {
            const key = keyOf(skill)
            if (preview[key] && preview[key].open) {
              setPreview((prev) => ({ ...prev, [key]: { open: false } }))
              return
            }
            setPreview((prev) => ({ ...prev, [key]: { open: true, text: null } }))
            try {
              const result = await call('read', { name: skill.name, file: skill.path ?? undefined })
              setPreview((prev) => ({ ...prev, [key]: { open: true, text: (result && result.content) || '' } }))
            } catch (error) {
              setPreview((prev) => ({ ...prev, [key]: { open: true, text: String((error && error.message) || error) } }))
            }
          }

          const view = useMemo(() => {
            if (!state.data) return null
            const q = query.trim().toLowerCase()
            const keyOfRow = (s) => s.path || s.name
            const all = state.data.skills
              .filter((s) => (filter === 'all' ? true : filter === 'enabled' ? s.enabled : !s.enabled))
              .filter((s) => q === '' || s.name.toLowerCase().includes(q)
                || String(s.description || '').toLowerCase().includes(q))
              .map((s) => (preview[keyOfRow(s)]
                ? { ...s, previewOpen: preview[keyOfRow(s)].open, previewText: preview[keyOfRow(s)].text }
                : s))
            const groups = { bundled: [], system: [], project: [] }
            for (const s of all) (groups[s.scope] ?? groups.system).push(s)
            const total = state.data.skills.length
            const enabled = state.data.skills.filter((s) => s.enabled).length
            return { groups, shown: all.length, total, enabled, disabled: total - enabled }
          }, [state, query, filter, preview])

          const children = [
            el('div', { key: 'h', style: S.head }, [
              el('div', { key: 't', style: S.title }, t('title')),
              el('div', { key: 's', style: S.subtitle }, t('subtitle')),
            ]),
            el('div', { key: 'tb', style: S.toolbar }, [
              el('input', {
                key: 'q', style: S.search, value: query, placeholder: t('search'),
                onChange: (event) => setQuery(event.target.value),
              }),
              el('div', { key: 'seg', style: S.segment },
                ['all', 'enabled', 'disabled'].map((key) => el('button', {
                  key, type: 'button',
                  style: S.segBtn(filter === key),
                  onClick: () => setFilter(key),
                }, t(key === 'all' ? 'filterAll' : key === 'enabled' ? 'filterEnabled' : 'filterDisabled')))),
              el('button', {
                key: 'r', type: 'button', style: S.ghost, onClick: () => void load(),
              }, t('refresh')),
            ]),
          ]

          if (state.status === 'loading') children.push(el('div', { key: 'ld', style: S.muted }, t('loading')))
          if (state.status === 'error') {
            children.push(el('div', { key: 'er', style: S.panel }, [
              el('div', { key: 't', style: S.panelText }, t('error') + ': ' + state.error),
              el('div', { key: 'a' }, el('button', {
                type: 'button', style: S.ghost, onClick: () => void load(),
              }, t('retry'))),
            ]))
          }

          if (state.status === 'ready' && view) {
            children.push(el('div', { key: 'st', style: S.stats }, [
              el('span', { key: 'a', style: S.stat }, [
                el('span', { key: '1', style: S.statNum }, String(view.total)),
                el('span', { key: '2', style: S.statLabel }, t('countSkills')),
              ]),
              el('span', { key: 'd1', style: S.dot }),
              el('span', { key: 'b', style: S.stat }, [
                el('span', { key: '1', style: S.statNum }, String(view.enabled)),
                el('span', { key: '2', style: S.statLabel }, t('countEnabled')),
              ]),
              el('span', { key: 'd2', style: S.dot }),
              el('span', { key: 'c', style: S.stat }, [
                el('span', { key: '1', style: S.statNum }, String(view.disabled)),
                el('span', { key: '2', style: S.statLabel }, t('countDisabled')),
              ]),
            ]))

            if (view.shown === 0) {
              children.push(el('div', { key: 'em', style: S.muted },
                view.total === 0 ? t('empty') : t('emptyFiltered')))
            }

            const BUCKETS = [
              ['bundled', 'scopeBundled'],
              ['system', 'scopeSystem'],
              ['project', 'scopeProject'],
            ]
            for (const [bucket, labelKey] of BUCKETS) {
              const items = view.groups[bucket]
              if (!items || items.length === 0) continue
              const keyOfRow = (s) => s.path || s.name
              children.push(el('div', { key: 'g-' + bucket, style: S.group }, [
                el('div', { key: 'gh', style: S.groupHead }, [
                  el('span', { key: 'l' }, t(labelKey)),
                  el('span', { key: 'c', style: S.groupCount }, String(items.length)),
                ]),
                ...items.map((skill) => el(SkillCard, {
                  key: keyOfRow(skill), skill, t, busy: Boolean(busy[keyOfRow(skill)]),
                  onToggle: () => void toggle(skill), onPreview: () => void openPreview(skill),
                })),
              ]))
            }
          }

          return el('div', { style: S.wrap }, children)
        }

        function apply(ctx) {
          try {
            ctx.effect(() => ctx.locale.register(LOCALE_NS, { zh, en }), 'decision-skills: locales')
            const t = ctx.locale.bind(LOCALE_NS)

            // 命名空间是异步到位的：用订阅驱动重渲染。
            const live = { namespace: null, sessionId: null }
            const listeners = new Set()
            const publish = (patch) => {
              Object.assign(live, patch)
              for (const notify of listeners) notify()
            }
            const useLive = () => {
              const [, force] = useState(0)
              useEffect(() => {
                const notify = () => force((n) => n + 1)
                listeners.add(notify)
                return () => { listeners.delete(notify) }
              }, [])
              return live
            }

            const SERVICE_KEY = 'remote.' + NS
            const readNamespace = () => {
              try { return ctx.get(SERVICE_KEY) ?? null } catch { return null }
            }

            const remote = ctx.remote
            if (remote && typeof remote.$mount === 'function') {
              const mounted = remote.$mount(TYPERT_REMOTE)
              const disposeRef = { current: null }
              Promise.resolve(mounted).then(
                (disposer) => {
                  disposeRef.current = typeof disposer === 'function' ? disposer : null
                  publish({ namespace: readNamespace() })
                  DIAG('remote', 'mounted')
                },
                (error) => {
                  DIAG('remote', 'mount failed: ' + String((error && error.message) || error))
                  publish({ namespace: null })
                },
              )
              ctx.effect(() => () => {
                if (disposeRef.current) disposeRef.current()
                disposeRef.current = null
              }, 'decision-skills: unmount remote')
            } else {
              DIAG('remote', 'ctx.remote.$mount unavailable')
            }

            const Section = (props) => {
              const liveState = useLive()
              return el(SkillManagerSection, {
                ...props,
                t,
                namespace: liveState.namespace,
                sessionId: liveState.sessionId,
              })
            }

            ctx.slots.inject(SLOT, () => ctx.slots.register({
              name: SLOT,
              id: SECTION_ID,
              order: 60,
              label: () => t('nav'),
              locale: LOCALE_NS,
              inject: () => ({}),
            }, Section))
          } catch (error) {
            DIAG('apply', String((error && error.message) || error) + '\n' + ((error && error.stack) || ''))
            throw error
          }
        }

        // inject 必须是 factory 返回对象的属性。不要声明 'remote.<ns>'。
        return { inject: ['slots', 'locale', 'remote'], apply }
      },
    })
  } catch (error) {
    const message = String((error && error.message) || error)
    if (message.includes('duplicate factory registration')) {
      DIAG('bootstrap', 'duplicate registration ignored')
    } else {
      DIAG('bootstrap', message)
      throw error
    }
  }
})()