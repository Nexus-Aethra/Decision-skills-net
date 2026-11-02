/**
 * decision-skills 浏览器半边：设置里的「技能」分区。
 *
 * 模块契约（照 @local/dsh-paper-fetch 已验证的写法）：
 *   window.__ModuleLoader__.load({ id, factory(require) { return { inject, apply } } })
 *
 * 硬约束：
 * - 不 import 任何 Harness Client 包；只借 --dsw-alias-* 主题变量。
 * - 顶层必须有 window 守卫：宿主 boot 审计只报 "failed"，不给原因。
 * - inject 是 factory 返回对象的属性，且不能声明自己要注册的 'remote.<ns>'。
 */
;(function () {
  const DIAG = (phase, detail) => {
    try { console.error('[decision-skills] ' + phase + ': ' + detail) } catch { /* 没有 console */ }
  }

  if (typeof window === 'undefined' || !window.__ModuleLoader__) {
    DIAG('bootstrap', 'no __ModuleLoader__; skipping')
    return
  }

  // 必须等于**包名**：宿主按包名去 client-modules 里找工厂函数，
  // 名字对不上会报 "loaded without registering <pkg>" 并让整个 boot 失败。
  const MODULE_ID = '@local/decision-skills-ui'

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

        /** 方法 -> wire 参数名，必须与宿主实参逐个对应。 */
        const METHOD_PARAMS = {
          list: [],
          listForSession: ['request'],
          read: ['request'],
          setEnabled: ['request'],
          removeSkill: ['request'],
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
              name, wire: name, source: 'json',
              codec: {
                mode: 'strict',
                typeSymbol: MODULE_ID + '#' + NS + '/' + method + ':' + name,
                create: PASS_THROUGH,
              },
            })),
            result: {
              mode: 'strict',
              typeSymbol: MODULE_ID + '#' + NS + '/' + method + ':result',
              create: PASS_THROUGH,
            },
          })),
        }

        const zh = {
          meta: { title: '技能管理', description: '浏览内置、系统级与各工作区的技能，支持按会话查看、开关与删除。' },
          nav: '技能', title: '技能管理',
          subtitle: '内置、系统级与各工作区的 SKILL.md',
          refresh: '刷新', search: '搜索技能',
          filterAll: '全部', filterEnabled: '已启用', filterDisabled: '已关闭',
          scopeBundled: '内置', scopeSystem: '系统级', scopeProject: '工作区',
          countSkills: '个技能', countEnabled: '已启用', countDisabled: '已关闭',
          viewAll: '全部会话', viewSession: '按会话',
          sessionPicker: '选择会话',
          noSessions: '还没有会话',
          scopedHint: '当前按会话隔离：只显示该会话作用域内的技能',
          unscopedHint: '当前为全局视角：汇总所有工作区',
          empty: '还没有发现技能。在 <工作区>/.agents/skills/<名字>/SKILL.md 新建即可。',
          emptyFiltered: '没有符合条件的技能。',
          loading: '正在读取…', error: '读取失败', retry: '重试',
          preview: '预览', collapse: '收起',
          noDescription: '（没有描述）',
          bundledHint: '内置技能随宿主发布，不可修改',
          remove: '删除', removeConfirm: '确认删除？', removeCancel: '取消',
          removeHint: '移到技能根下的 .trash/<时间戳>/，可手动恢复',
          removed: '已移到回收目录',
          removeFailed: '删除失败',
          unreachable: '端点不可达',
        }
        const en = {
          meta: { title: 'Skill Manager', description: 'Browse bundled, system and workspace skills with per-session view, toggling and removal.' },
          nav: 'Skills', title: 'Skill Manager',
          subtitle: 'SKILL.md across bundled, system and workspace roots',
          refresh: 'Refresh', search: 'Search skills',
          filterAll: 'All', filterEnabled: 'Enabled', filterDisabled: 'Disabled',
          scopeBundled: 'Bundled', scopeSystem: 'System', scopeProject: 'Workspace',
          countSkills: 'skills', countEnabled: 'enabled', countDisabled: 'disabled',
          viewAll: 'All sessions', viewSession: 'By session',
          sessionPicker: 'Pick a session',
          noSessions: 'No sessions yet',
          scopedHint: 'Scoped to one session: only skills visible in that scope',
          unscopedHint: 'Global view: every workspace combined',
          empty: 'No skills found yet. Create one at <workspace>/.agents/skills/<name>/SKILL.md.',
          emptyFiltered: 'No skills match the filters.',
          loading: 'Loading…', error: 'Failed to load', retry: 'Retry',
          preview: 'Preview', collapse: 'Collapse',
          noDescription: '(no description)',
          bundledHint: 'Bundled skills ship with the host and are read-only',
          remove: 'Remove', removeConfirm: 'Confirm removal?', removeCancel: 'Cancel',
          removeHint: 'Moves to .trash/<timestamp>/ under the skill root, recoverable',
          removed: 'Moved to trash',
          removeFailed: 'Removal failed',
          unreachable: 'Endpoint unreachable',
        }

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
            border: 'none', borderRadius: 7,
            background: on ? 'var(--dsw-alias-bg-layer-2)' : 'transparent',
            color: on ? 'var(--dsw-alias-label-primary)' : 'var(--dsw-alias-label-secondary)',
            boxShadow: on ? '0 1px 2px rgba(0,0,0,.06)' : 'none',
            transition: 'background 120ms ease, color 120ms ease',
          }),
          ghost: (disabled) => ({
            height: 34, padding: '0 13px', fontSize: 12.5,
            cursor: disabled ? 'not-allowed' : 'pointer',
            color: 'var(--dsw-alias-label-secondary)',
            background: 'transparent',
            border: '1px solid var(--dsw-alias-border-l1)',
            borderRadius: 10, opacity: disabled ? .5 : 1,
            transition: 'background 120ms ease',
          }),
          select: {
            height: 34, padding: '0 10px', fontSize: 12.5, cursor: 'pointer',
            color: 'var(--dsw-alias-label-primary)',
            background: 'var(--dsw-alias-bg-layer-1)',
            border: '1px solid var(--dsw-alias-border-l1)',
            borderRadius: 10, outline: 'none', maxWidth: 220,
          },

          stats: { display: 'flex', gap: 14, alignItems: 'center', flexWrap: 'wrap' },
          stat: { display: 'flex', alignItems: 'baseline', gap: 5 },
          statNum: { fontSize: 13, fontWeight: 600, color: 'var(--dsw-alias-label-primary)' },
          statLabel: { fontSize: 12, color: 'var(--dsw-alias-label-tertiary)' },
          dot: { width: 3, height: 3, borderRadius: '50%', background: 'var(--dsw-alias-border-l3)' },

          hint: {
            fontSize: 12, lineHeight: 1.55, color: 'var(--dsw-alias-label-tertiary)',
            padding: '8px 12px', borderRadius: 10,
            background: 'var(--dsw-alias-bg-layer-1)',
            border: '1px solid var(--dsw-alias-border-l1)',
          },

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
          actions: { display: 'flex', alignItems: 'center', gap: 6, marginTop: 2, flexWrap: 'wrap' },
          tagBtn: (danger) => ({
            height: 24, padding: '0 10px', fontSize: 11.5, cursor: 'pointer',
            color: danger ? 'var(--dsw-alias-state-error-primary)' : 'var(--dsw-alias-label-secondary)',
            background: 'transparent',
            border: '1px solid ' + (danger ? 'var(--dsw-alias-state-error-primary)' : 'var(--dsw-alias-border-l1)'),
            borderRadius: 8, transition: 'background 120ms ease',
          }),
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
          menu: {
            position: 'absolute', top: 38, left: 0, zIndex: 50,
            minWidth: 220, maxHeight: 280, overflow: 'auto',
            display: 'flex', flexDirection: 'column', gap: 2, padding: 6,
            background: 'var(--dsw-alias-bg-layer-2)',
            border: '1px solid var(--dsw-alias-border-l1)',
            borderRadius: 12,
            boxShadow: '0 8px 24px rgba(0,0,0,.14)',
          },
          menuItem: (on) => ({
            textAlign: 'left', padding: '7px 10px', fontSize: 12.5, cursor: 'pointer',
            border: 'none', borderRadius: 8,
            background: on ? 'var(--dsw-alias-interactive-bg-hover)' : 'transparent',
            color: on ? 'var(--dsw-alias-label-primary)' : 'var(--dsw-alias-label-secondary)',
            whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
          }),
          menuEmpty: { padding: '8px 10px', fontSize: 12, color: 'var(--dsw-alias-label-tertiary)' },
        }

        const el = (tag, props, children) => React.createElement(tag, props, children)

        function Switch({ on, busy, disabled, onToggle, label }) {
          return el('button', {
            type: 'button', role: 'switch', 'aria-checked': on, 'aria-label': label,
            'aria-disabled': disabled ? 'true' : 'false',
            disabled: busy || disabled, onClick: onToggle,
            style: S.switchTrack(on, disabled),
          }, el('span', { style: S.switchKnob(on) }))
        }

        function SkillCard({ skill, t, busy, confirming, onToggle, onPreview, onAskRemove, onCancelRemove, onConfirmRemove }) {
          const readOnly = skill.editable === false
          const actions = [
            el('button', { key: 'pv', type: 'button', style: S.tagBtn(false), onClick: onPreview },
              skill.previewOpen ? t('collapse') : t('preview')),
          ]
          if (!readOnly) {
            if (confirming) {
              actions.push(el('button', { key: 'yes', type: 'button', style: S.tagBtn(true), onClick: onConfirmRemove }, t('removeConfirm')))
              actions.push(el('button', { key: 'no', type: 'button', style: S.tagBtn(false), onClick: onCancelRemove }, t('removeCancel')))
            } else {
              actions.push(el('button', { key: 'rm', type: 'button', style: S.tagBtn(true), onClick: onAskRemove }, t('remove')))
            }
          }
          return el('div', { style: S.card(readOnly) }, [
            el('div', { key: 'm', style: S.cardMain }, [
              el('div', { key: 'n', style: S.nameRow }, [
                el('span', { key: 'nn', style: S.name }, skill.name),
                skill.source ? el('span', { key: 's', style: S.pill }, skill.source) : null,
                readOnly ? el('span', { key: 'ro', style: S.pill }, t('bundledHint')) : null,
              ]),
              el('div', { key: 'd', style: S.desc }, skill.description || t('noDescription')),
              skill.path ? el('div', { key: 'p', style: S.path }, skill.path) : null,
              el('div', { key: 'a', style: S.actions }, actions),
              confirming ? el('div', { key: 'rh', style: S.path }, t('removeHint')) : null,
              skill.previewOpen
                ? el('div', { key: 'pv2', style: S.preview }, skill.previewText ?? t('loading'))
                : null,
            ]),
            el(Switch, { key: 'sw', on: skill.enabled, busy, disabled: readOnly, onToggle, label: skill.name }),
          ])
        }

        function SkillManagerSection(props) {
          const t = props.t
          const [state, setState] = useState({ status: 'loading', data: null, error: null })
          const [query, setQuery] = useState('')
          const [filter, setFilter] = useState('all')
          const [sessionId, setSessionId] = useState('')
          const [busy, setBusy] = useState({})
          const [preview, setPreview] = useState({})
          const [confirming, setConfirming] = useState({})
          const [notice, setNotice] = useState(null)
          const [openMenu, setOpenMenu] = useState(false)

          const call = async (method, request) => {
            const ns = props.namespace
            if (!ns || typeof ns[method] !== 'function') {
              throw new Error(t('unreachable') + ': ' + NS + '/' + method)
            }
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

          const load = async (sid) => {
            setState((prev) => ({ status: 'loading', data: prev.data, error: null }))
            try {
              const wanted = sid ?? sessionId
              const data = wanted !== '' && wanted != null
                ? await call('listForSession', { sessionId: wanted })
                : await call('list')
              setState({ status: 'ready', data, error: null })
            } catch (error) {
              setState({ status: 'error', data: null, error: String((error && error.message) || error) })
            }
          }

          useEffect(() => { void load('') }, [])

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

          const removeSkill = async (skill) => {
            const key = keyOf(skill)
            setBusy((prev) => ({ ...prev, [key]: true }))
            try {
              const outcome = await call('removeSkill', { path: skill.path, name: skill.name })
              if (outcome && outcome.ok === false) {
                setNotice({ kind: 'error', text: t('removeFailed') + ': ' + String(outcome.error) })
              } else {
                setNotice({ kind: 'ok', text: t('removed') + (outcome?.movedTo ? ' → ' + outcome.movedTo : '') })
              }
            } catch (error) {
              setNotice({ kind: 'error', text: t('removeFailed') + ': ' + String((error && error.message) || error) })
            }
            setConfirming((prev) => ({ ...prev, [key]: false }))
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
              const result = await call('read', {
                name: skill.name,
                path: skill.path ?? undefined,
                archivePath: skill.archivePath ?? undefined,
              })
              setPreview((prev) => ({ ...prev, [key]: { open: true, text: (result && result.content) || '' } }))
            } catch (error) {
              setPreview((prev) => ({ ...prev, [key]: { open: true, text: String((error && error.message) || error) } }))
            }
          }

          const changeSession = (value) => {
            setSessionId(value)
            setPreview({})
            setConfirming({})
            setNotice(null)
            void load(value)
          }

          const view = useMemo(() => {
            if (!state.data) return null
            const q = query.trim().toLowerCase()
            const all = state.data.skills
              .filter((s) => (filter === 'all' ? true : filter === 'enabled' ? s.enabled : !s.enabled))
              .filter((s) => q === '' || s.name.toLowerCase().includes(q)
                || String(s.description || '').toLowerCase().includes(q))
              .map((s) => {
                const k = keyOf(s)
                const patch = {}
                if (preview[k]) { patch.previewOpen = preview[k].open; patch.previewText = preview[k].text }
                if (confirming[k]) patch.confirming = true
                return { ...s, ...patch }
              })
            const groups = { bundled: [], system: [], project: [] }
            for (const s of all) (groups[s.scope] ?? groups.system).push(s)
            const total = state.data.skills.length
            const enabled = state.data.skills.filter((s) => s.enabled).length
            return { groups, shown: all.length, total, enabled, disabled: total - enabled }
          }, [state, query, filter, preview, confirming])

          const sessions = (state.data && state.data.sessions) ?? []
          const scoped = sessionId !== ''

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
                  key, type: 'button', style: S.segBtn(filter === key),
                  onClick: () => setFilter(key),
                }, t(key === 'all' ? 'filterAll' : key === 'enabled' ? 'filterEnabled' : 'filterDisabled')))),
              el('button', {
                key: 'r', type: 'button', style: S.ghost(false), onClick: () => void load(),
              }, t('refresh')),
            ]),
            el('div', { key: 'sb', style: S.toolbar }, [
              el('span', { key: 'l', style: S.statLabel },
                t('viewSession') + '（' + sessions.length + '）：'),
              // 自绘下拉：原生 select 的 option 在无障碍树里不暴露，
              // 也拿不到一致的样式，这里用按钮 + 列表，行为完全可控。
              el('div', { key: 'dd', style: { position: 'relative' } }, [
                el('button', {
                  key: 'btn', type: 'button',
                  style: { ...S.ghost(false), minWidth: 180, textAlign: 'left' },
                  onClick: () => setOpenMenu((v) => !v),
                }, scoped
                  ? (sessions.find((s) => s.id === sessionId)?.title ?? sessionId).slice(0, 34)
                  : t('viewAll') + ' ?'),
                openMenu
                  ? el('div', { key: 'menu', style: S.menu }, [
                      el('button', {
                        key: 'all', type: 'button', style: S.menuItem(!scoped),
                        onClick: () => { setOpenMenu(false); changeSession('') },
                      }, t('viewAll')),
                      ...sessions.slice(0, 60).map((s) => el('button', {
                        key: s.id, type: 'button', style: S.menuItem(sessionId === s.id),
                        onClick: () => { setOpenMenu(false); changeSession(s.id) },
                      }, String(s.title || s.id).slice(0, 44))),
                      sessions.length === 0
                        ? el('div', { key: 'none', style: S.menuEmpty }, t('noSessions'))
                        : null,
                    ])
                  : null,
              ]),
              scoped ? el('span', { key: 'h', style: S.statLabel }, t('scopedHint')) : null,
            ]),
          ]

          if (notice) {
            children.push(el('div', { key: 'nt', style: S.panel }, [
              el('div', { key: 'x', style: S.panelText }, notice.text),
            ]))
          }

          if (state.status === 'loading' && !state.data) {
            children.push(el('div', { key: 'ld', style: S.muted }, t('loading')))
          }
          if (state.status === 'error') {
            children.push(el('div', { key: 'er', style: S.panel }, [
              el('div', { key: 't', style: S.panelText }, t('error') + ': ' + state.error),
              el('div', { key: 'a' }, el('button', {
                type: 'button', style: S.ghost(false), onClick: () => void load(),
              }, t('retry'))),
            ]))
          }

          if (view) {
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
              children.push(el('div', { key: 'g-' + bucket, style: S.group }, [
                el('div', { key: 'gh', style: S.groupHead }, [
                  el('span', { key: 'l' }, t(labelKey)),
                  el('span', { key: 'c', style: S.groupCount }, String(items.length)),
                ]),
                ...items.map((skill) => {
                  const k = keyOf(skill)
                  return el(SkillCard, {
                    key: k, skill, t,
                    busy: Boolean(busy[k]),
                    confirming: Boolean(confirming[k]),
                    onToggle: () => void toggle(skill),
                    onPreview: () => void openPreview(skill),
                    onAskRemove: () => { setConfirming((p) => ({ ...p, [k]: true })); setNotice(null) },
                    onCancelRemove: () => setConfirming((p) => ({ ...p, [k]: false })),
                    onConfirmRemove: () => void removeSkill(skill),
                  })
                }),
              ]))
            }
          }

          return el('div', { style: S.wrap }, children)
        }

        function apply(ctx) {
          try {
            ctx.effect(() => ctx.locale.register(LOCALE_NS, { zh, en }), 'decision-skills: locales')
            const t = ctx.locale.bind(LOCALE_NS)

            const live = { namespace: null }
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
              return el(SkillManagerSection, { ...props, t, namespace: liveState.namespace })
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
