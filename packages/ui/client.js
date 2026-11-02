/**
 * decision-skills 浏览器半边：左侧栏独立面板。
 *
 * 三个仓库（与 source 严格对应）：
 *   system  内嵌（asar + 安装 assets）—— 只能控「对 agent 可见」，不可删
 *   common  ~/.dsh/skills —— 通用级，可开关/删除
 *   project 各工作区 .agents/skills —— 项目级，可开关/删除/提升
 *
 * 开关语义：**agent 能否在 skills 列表里看到**。
 *
 * 模块契约：window.__ModuleLoader__.load({ id: 包名, factory(require) { return { inject, apply } } })
 * id 必须等于包名，否则 boot 报 "loaded without registering <pkg>"。
 */
;(function () {
  const DIAG = (phase, detail) => {
    try { console.error('[decision-skills] ' + phase + ': ' + detail) } catch { /* 没有 console */ }
  }

  if (typeof window === 'undefined' || !window.__ModuleLoader__) {
    DIAG('bootstrap', 'no __ModuleLoader__; skipping')
    return
  }

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
        const PANEL_ID = 'skills'
        const PASS_THROUGH = () => ({ parse: (value) => value })

        const METHOD_PARAMS = {
          list: [],
          listForSession: ['request'],
          read: ['request'],
          setEnabled: ['request'],
          removeSkill: ['request'],
          setVisibility: ['request'],
          promoteSkill: ['request'],
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
          meta: { title: '技能仓库', description: '系统级、通用级与项目级三个技能仓库，按会话控制可见度。' },
          panel: '技能仓库', title: '技能仓库',
          subtitle: '三个仓库：内嵌只读、通用可改、项目随工作区',
          repoSystem: '系统级', repoCommon: '通用级', repoProject: '项目级',
          repoSystemHint: '内嵌于宿主，不可修改；只能控制 agent 是否可见',
          repoCommonHint: '~/.dsh/skills',
          repoProjectHint: '各工作区的 .agents/skills',
          refresh: '刷新', search: '搜索技能',
          filterAll: '全部', filterVisible: '可见', filterHidden: '不可见',
          mode_off: '关闭', mode_smart: '智能', mode_on: '开启',
          modeHint_off: 'agent 完全看不到这个技能',
          modeHint_smart: '进入候选池，由决策模型决定何时注入（尚未接入，当前不生效）',
          modeHint_on: '始终对 agent 可见',
          tabAll: '全部',
          preview: '预览', collapse: '收起',
          remove: '删除', removeConfirm: '确认删除？', removeCancel: '取消',
          removed: '已移到回收目录',
          smartTitle: '智能注入',
          smartPending: '需要本地决策模型，尚未接入。这是占位入口。',
          promote: '提升到通用级',
          promoted: '已复制到 ~/.dsh/skills（项目原件保留）',
          promoteFailed: '提升失败',
          chooseProject: '按项目筛选',
          allProjects: '全部项目',
          noDescription: '（没有描述）',
          empty: '这个仓库还没有技能。',
          emptyFiltered: '没有符合条件的技能。',
          loading: '正在读取…', error: '读取失败', retry: '重试',
          unreachable: '端点不可达',
        }
        const en = {
          meta: { title: 'Skill Repos', description: 'System, common and project repositories with per-session visibility.' },
          panel: 'Skill Repos', title: 'Skill Repos',
          subtitle: 'Three repositories: embedded read-only, common editable, project scoped',
          repoSystem: 'System', repoCommon: 'Common', repoProject: 'Project',
          repoSystemHint: 'Embedded in the host; read-only, visibility only',
          repoCommonHint: '~/.dsh/skills',
          repoProjectHint: 'Each workspace .agents/skills',
          refresh: 'Refresh', search: 'Search skills',
          filterAll: 'All', filterVisible: 'Visible', filterHidden: 'Hidden',
          mode_off: 'Off', mode_smart: 'Smart', mode_on: 'On',
          modeHint_off: 'The agent cannot see this skill at all',
          modeHint_smart: 'Enters the candidate pool; a decision model picks when to inject (not wired up yet)',
          modeHint_on: 'Always visible to the agent',
          tabAll: 'All',
          preview: 'Preview', collapse: 'Collapse',
          remove: 'Remove', removeConfirm: 'Confirm removal?', removeCancel: 'Cancel',
          removed: 'Moved to trash',
          smartTitle: 'Smart injection',
          smartPending: 'Requires a local decision model; not wired up yet. Placeholder entry.',
          promote: 'Promote to common',
          promoted: 'Copied to ~/.dsh/skills (project original kept)',
          promoteFailed: 'Promote failed',
          chooseProject: 'Filter by project',
          allProjects: 'All projects',
          noDescription: '(no description)',
          empty: 'No skills in this repository yet.',
          emptyFiltered: 'No skills match the filters.',
          loading: 'Loading…', error: 'Failed to load', retry: 'Retry',
          unreachable: 'Endpoint unreachable',
        }
        const S = {
          page: {
            display: 'flex', flexDirection: 'column', gap: 16, height: '100%',
            padding: '20px 24px', boxSizing: 'border-box', overflow: 'auto',
            color: 'var(--dsw-alias-label-primary)',
          },
          head: { display: 'flex', flexDirection: 'column', gap: 4 },
          title: { fontSize: 17, fontWeight: 600 },
          subtitle: { fontSize: 12.5, lineHeight: 1.5, color: 'var(--dsw-alias-label-tertiary)' },
          toolbar: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' },
          search: {
            flex: '1 1 200px', minWidth: 160, height: 34, padding: '0 12px', fontSize: 13,
            background: 'var(--dsw-alias-bg-layer-1)',
            border: '1px solid var(--dsw-alias-border-l1)',
            borderRadius: 10, outline: 'none', boxSizing: 'border-box',
            color: 'var(--dsw-alias-label-primary)',
          },
          segment: {
            display: 'inline-flex', gap: 2, padding: 3,
            background: 'var(--dsw-alias-bg-layer-1)',
            border: '1px solid var(--dsw-alias-border-l1)', borderRadius: 10,
          },
          segBtn: (on) => ({
            height: 26, padding: '0 11px', fontSize: 12, cursor: 'pointer',
            border: 'none', borderRadius: 7,
            background: on ? 'var(--dsw-alias-bg-layer-2)' : 'transparent',
            color: on ? 'var(--dsw-alias-label-primary)' : 'var(--dsw-alias-label-secondary)',
          }),
          ghost: {
            height: 34, padding: '0 13px', fontSize: 12.5, cursor: 'pointer',
            color: 'var(--dsw-alias-label-secondary)', background: 'transparent',
            border: '1px solid var(--dsw-alias-border-l1)', borderRadius: 10,
          },
          // 顶部分页：整行等分，当前页用底部指示线。
          tabs: {
            display: 'flex', gap: 4,
            borderBottom: '1px solid var(--dsw-alias-border-l1)',
          },
          tab: (on) => ({
            display: 'inline-flex', alignItems: 'center', gap: 6,
            padding: '9px 14px', fontSize: 13, cursor: 'pointer',
            border: 'none', background: 'transparent',
            color: on ? 'var(--dsw-alias-label-primary)' : 'var(--dsw-alias-label-tertiary)',
            fontWeight: on ? 600 : 400,
            borderBottom: '2px solid ' + (on ? 'var(--dsw-alias-state-business-primary)' : 'transparent'),
            marginBottom: -1,
            transition: 'color 120ms ease, border-color 120ms ease',
          }),
          tabCount: (on) => ({
            fontSize: 10.5, padding: '1px 6px', borderRadius: 999,
            background: on ? 'var(--dsw-alias-bg-layer-2)' : 'var(--dsw-alias-bg-layer-1)',
            color: 'var(--dsw-alias-label-tertiary)',
            border: '1px solid var(--dsw-alias-border-l1)',
          }),
          repo: { display: 'flex', flexDirection: 'column', gap: 10 },
          repoHead: { display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' },
          repoName: { fontSize: 13, fontWeight: 600 },
          repoCount: {
            fontSize: 11, padding: '1px 7px', borderRadius: 999,
            color: 'var(--dsw-alias-label-tertiary)',
            background: 'var(--dsw-alias-bg-layer-1)',
          },
          repoHint: { fontSize: 11.5, color: 'var(--dsw-alias-label-tertiary)' },
          card: {
            display: 'flex', alignItems: 'flex-start', gap: 12, padding: '12px 14px',
            background: 'var(--dsw-alias-bg-layer-1)',
            border: '1px solid var(--dsw-alias-border-l1)',
            borderRadius: 14,
          },
          cardMain: { display: 'flex', flexDirection: 'column', gap: 6, flex: 1, minWidth: 0 },
          nameRow: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
          name: { fontSize: 13.5, fontWeight: 600 },
          pill: {
            fontSize: 10.5, padding: '2px 8px', borderRadius: 999,
            color: 'var(--dsw-alias-label-tertiary)',
            background: 'var(--dsw-alias-bg-layer-2)',
            border: '1px solid var(--dsw-alias-border-l1)',
          },
          desc: {
            fontSize: 12.5, lineHeight: 1.55, color: 'var(--dsw-alias-label-secondary)',
            overflow: 'hidden', textOverflow: 'ellipsis', display: '-webkit-box',
            WebkitLineClamp: 2, WebkitBoxOrient: 'vertical',
          },
          path: { fontSize: 11, color: 'var(--dsw-alias-label-tertiary)', wordBreak: 'break-all' },
          actions: { display: 'flex', alignItems: 'center', gap: 6, marginTop: 2, flexWrap: 'wrap' },
          tagBtn: (danger) => ({
            height: 24, padding: '0 10px', fontSize: 11.5, cursor: 'pointer',
            color: danger ? 'var(--dsw-alias-state-error-primary)' : 'var(--dsw-alias-label-secondary)',
            background: 'transparent',
            border: '1px solid ' + (danger ? 'var(--dsw-alias-state-error-primary)' : 'var(--dsw-alias-border-l1)'),
            borderRadius: 8,
          }),
          preview: {
            marginTop: 2, padding: '12px 14px', borderRadius: 12, maxHeight: 300, overflow: 'auto',
            background: 'var(--dsw-alias-bg-layer-2)',
            border: '1px solid var(--dsw-alias-border-l1)',
            fontSize: 12, lineHeight: 1.65, whiteSpace: 'pre-wrap', wordBreak: 'break-word',
          },
          switchTrack: (on) => ({
            width: 38, height: 22, borderRadius: 999, border: 'none', cursor: 'pointer',
            padding: 0, position: 'relative', flex: '0 0 auto', marginTop: 1,
            background: on ? 'var(--dsw-alias-state-business-primary)' : 'var(--dsw-alias-border-l3)',
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
            padding: '12px 14px', borderRadius: 12,
            background: 'var(--dsw-alias-bg-layer-1)',
            border: '1px solid var(--dsw-alias-border-l1)',
          },
          panelText: { fontSize: 12.5, lineHeight: 1.6, color: 'var(--dsw-alias-label-secondary)' },
        }
        const el = (tag, props, children) => React.createElement(tag, props, children)

        /** 三种档位，顺序即滑块的从左到右。 */
        const MODES = ['off', 'smart', 'on']

        /**
         * 三阶段滑块：关闭 / 智能 / 开启。
         *
         * 不用单按钮循环切换——那让"当前在哪一档"和"下一档是什么"都不可见。
         * 这里做成三段轨道，点任意一段直接跳到该档，当前档高亮。
         *
         * 智能档在接入决策模型前等同于关闭（agent 不可见），
         * 但状态保留，将来只需改 scanner 的 visible 判定。
         */
        function ModeSlider({ mode, busy, disabled, onChange, label, t }) {
          const index = Math.max(0, MODES.indexOf(mode))
          const knobLeft = index === 0 ? 3 : index === 1 ? 33 : 63
          // 颜色映射（按产品要求）：
          //   关闭 = 中性灰，智能 = 蓝（品牌色），开启 = 绿（success）
          const trackColor = mode === 'on'
            ? 'var(--dsw-alias-state-success-primary)'
            : mode === 'smart'
              ? 'var(--dsw-alias-brand-primary)'
              : 'var(--dsw-alias-border-l3)'
          return el('div', {
            role: 'group',
            'aria-label': label,
            title: label,
            style: { display: 'flex', alignItems: 'center', gap: 8, opacity: disabled ? .5 : 1 },
          }, [
            el('div', {
              key: 'track',
              style: {
                position: 'relative', width: 96, height: 22, borderRadius: 999,
                background: trackColor,
                transition: 'background 160ms ease',
              },
            }, [
              // 三段可点击区域
              ...MODES.map((m, i) => el('button', {
                key: m,
                type: 'button',
                role: 'radio',
                'aria-checked': mode === m,
                'aria-label': m,
                title: m,
                disabled: busy || disabled,
                onClick: () => onChange(m),
                style: {
                  position: 'absolute',
                  left: 2 + i * 30,
                  top: 0,
                  width: 30,
                  height: 22,
                  border: 'none',
                  background: 'transparent',
                  cursor: busy || disabled ? 'not-allowed' : 'pointer',
                  padding: 0,
                },
              })),
              el('span', {
                key: 'knob',
                style: {
                  position: 'absolute', top: 3, left: knobLeft, width: 30, height: 16,
                  borderRadius: 999, background: '#fff',
                  boxShadow: '0 1px 3px rgba(0,0,0,.18)',
                  pointerEvents: 'none',
                  transition: 'left 180ms cubic-bezier(.4,0,.2,1)',
                },
              }),
            ]),
          ])
        }

        /** 滑块旁的档位文字，让人一眼看出三档分别是什么。 */
        function ModeLegend({ mode, t }) {
          return el('span', {
            style: {
              fontSize: 11.5, minWidth: 34, textAlign: 'right',
              color: mode === 'on'
                ? 'var(--dsw-alias-state-success-primary)'
                : mode === 'smart'
                  ? 'var(--dsw-alias-brand-primary)'
                  : 'var(--dsw-alias-label-tertiary)',
            },
          }, t('mode_' + (mode ?? 'off')))
        }

        function SkillCard({ skill, t, busy, confirming, onMode, onPreview, onAskRemove, onCancelRemove, onConfirmRemove, onPromote }) {
          // 系统级不可删（内嵌只读）；其余可删。
          const canRemove = skill.scope !== 'system'
          const actions = [
            el('button', { key: 'pv', type: 'button', style: S.tagBtn(false), onClick: onPreview },
              skill.previewOpen ? t('collapse') : t('preview')),
          ]
          if (canRemove) {
            if (confirming) {
              actions.push(el('button', { key: 'yes', type: 'button', style: S.tagBtn(true), onClick: onConfirmRemove }, t('removeConfirm')))
              actions.push(el('button', { key: 'no', type: 'button', style: S.tagBtn(false), onClick: onCancelRemove }, t('removeCancel')))
            } else {
              actions.push(el('button', { key: 'rm', type: 'button', style: S.tagBtn(true), onClick: onAskRemove }, t('remove')))
            }
          }
          if (skill.scope === 'project') {
            actions.push(el('button', { key: 'pr', type: 'button', style: S.tagBtn(false), onClick: onPromote }, t('promote')))
          }
          return el('div', { style: S.card }, [
            el('div', { key: 'm', style: S.cardMain }, [
              // 名称旁不再放状态 pill：三档滑块的位置本身就是状态，
              // 重复一个文字标签只会让一行变挤。
              el('div', { key: 'n', style: S.nameRow },
                el('span', { key: 'nn', style: S.name }, skill.name),
              ),
              el('div', { key: 'd', style: S.desc }, skill.description || t('noDescription')),
              skill.path ? el('div', { key: 'pa', style: S.path }, skill.path) : null,
              el('div', { key: 'a', style: S.actions }, actions),
              skill.previewOpen
                ? el('div', { key: 'pv2', style: S.preview }, skill.previewText ?? t('loading'))
                : null,
            ]),
            el('div', { key: 'ctl', style: { display: 'flex', alignItems: 'center', gap: 8, marginTop: 1 } }, [
              el(ModeSlider, {
                key: 'slider',
                mode: skill.mode ?? 'off',
                busy,
                disabled: false,
                onChange: onMode,
                label: skill.name,
                t,
              }),
              el(ModeLegend, { key: 'lg', mode: skill.mode ?? 'off', t }),
            ]),
          ])
        }
        function SkillRepoPage(props) {
          const t = props.t
          const [state, setState] = useState({ status: 'loading', data: null, error: null })
          const [query, setQuery] = useState('')
          const [filter, setFilter] = useState('all')
          const [busy, setBusy] = useState({})
          const [preview, setPreview] = useState({})
          const [confirming, setConfirming] = useState({})
          const [notice, setNotice] = useState(null)
          // 顶部分页：一次只看一个仓库，避免三仓纵向堆叠过长
          const [tab, setTab] = useState('system')
          // 项目级按工作区筛选：'' 表示全部项目
          const [workspace, setWorkspace] = useState('')

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

          const load = async () => {
            setState((prev) => ({ status: 'loading', data: prev.data, error: null }))
            try {
              setState({ status: 'ready', data: await call('list'), error: null })
            } catch (error) {
              setState({ status: 'error', data: null, error: String((error && error.message) || error) })
            }
          }

          useEffect(() => { void load() }, [])

          const keyOf = (s) => s.path || s.archivePath || s.name

          const setMode = async (skill, mode) => {
            const key = keyOf(skill)
            setBusy((prev) => ({ ...prev, [key]: true }))
            try {
              const outcome = await call('setVisibility', {
                key,
                name: skill.name,
                path: skill.path ?? undefined,
                archivePath: skill.archivePath ?? undefined,
                mode,
              })
              if (outcome && outcome.ok === false) DIAG('setVisibility', 'rejected: ' + String(outcome.error))
            } catch (error) {
              DIAG('setVisibility', String((error && error.message) || error))
            }
            setBusy((prev) => ({ ...prev, [key]: false }))
            await load()
          }

          const removeSkill = async (skill) => {
            const key = keyOf(skill)
            setBusy((prev) => ({ ...prev, [key]: true }))
            try {
              const outcome = await call('removeSkill', { path: skill.path, name: skill.name })
              setNotice({ text: outcome?.ok === false ? String(outcome.error) : t('removed') })
            } catch (error) {
              setNotice({ text: String((error && error.message) || error) })
            }
            setConfirming((prev) => ({ ...prev, [key]: false }))
            setBusy((prev) => ({ ...prev, [key]: false }))
            await load()
          }

          // 提升到通用级：真正落盘（复制到 ~/.dsh/skills/<name>/）
          const promoteSkill = async (skill) => {
            const key = keyOf(skill)
            setBusy((prev) => ({ ...prev, [key]: true }))
            try {
              const outcome = await call('promoteSkill', { path: skill.path })
              if (outcome && outcome.ok === false) {
                setNotice({ text: t('promoteFailed') + ': ' + String(outcome.error ?? '') })
              } else {
                setNotice({ text: t('promoted') })
              }
            } catch (error) {
              setNotice({ text: t('promoteFailed') + ': ' + String((error && error.message) || error) })
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
          const view = useMemo(() => {
            if (!state.data) return null
            const q = query.trim().toLowerCase()
            const rows = state.data.skills
              // 筛选直接对齐三态：全部 / 关闭 / 智能 / 开启
              .filter((s) => (filter === 'all' ? true : (s.mode ?? 'off') === filter))
              .filter((s) => q === '' || s.name.toLowerCase().includes(q)
                || String(s.description || '').toLowerCase().includes(q))
              .map((s) => {
                const k = keyOf(s)
                const patch = {}
                if (preview[k]) { patch.previewOpen = preview[k].open; patch.previewText = preview[k].text }
                if (confirming[k]) patch.confirming = true
                return { ...s, ...patch }
              })
            // 每个仓库的条目数（用于 tab 徽标，过滤前统计）
            const counts = { system: 0, common: 0, project: 0 }
            for (const s of state.data.skills) counts[s.scope] = (counts[s.scope] ?? 0) + 1
            // 当前 tab 下的条目；项目级再按选中的工作区过滤
            const current = rows
              .filter((s) => (s.scope ?? 'common') === tab)
              .filter((s) => tab !== 'project' || workspace === '' || s.projectPath === workspace)
            return { counts, current, shown: current.length, total: state.data.skills.length }
          // tab 与 workspace 必须进依赖：view.current 按它们过滤，
          // 漏了哪个哪个的切换就不会重算，点了没反应。
          }, [state, query, filter, preview, confirming, tab, workspace])

          const children = [
            el('div', { key: 'h', style: S.head }, [
              el('div', { key: 't', style: S.title }, t('title')),
              el('div', { key: 's', style: S.subtitle }, t('subtitle')),
            ]),
            el('div', { key: 'tb', style: S.toolbar }, [
              el('input', {
                key: 'q', style: S.search, value: query, placeholder: t('search'),
                onChange: (e) => setQuery(e.target.value),
              }),
              el('div', { key: 'seg', style: S.segment },
                ['all', 'off', 'smart', 'on'].map((k) => el('button', {
                  key: k, type: 'button', style: S.segBtn(filter === k),
                  onClick: () => setFilter(k),
                }, t(k === 'all' ? 'filterAll' : 'mode_' + k)))),
              el('button', { key: 'r', type: 'button', style: S.ghost, onClick: () => void load() }, t('refresh')),
            ]),
          ]

          if (notice) {
            children.push(el('div', { key: 'nt', style: S.panel }, el('div', { style: S.panelText }, notice.text)))
          }
          if (state.status === 'loading' && !state.data) {
            children.push(el('div', { key: 'ld', style: S.muted }, t('loading')))
          }
          if (state.status === 'error') {
            children.push(el('div', { key: 'er', style: S.panel }, [
              el('div', { key: 't', style: S.panelText }, t('error') + ': ' + state.error),
              el('button', { key: 'a', type: 'button', style: S.ghost, onClick: () => void load() }, t('retry')),
            ]))
          }

          if (view) {
            // 顶部分页：系统级 / 通用级 / 项目级。一次只看一个仓库。
            const TABS = [
              ['system', 'repoSystem', 'repoSystemHint'],
              ['common', 'repoCommon', 'repoCommonHint'],
              ['project', 'repoProject', 'repoProjectHint'],
            ]
            children.push(el('div', { key: 'tabs', style: S.tabs },
              TABS.map(([key, labelKey, hintKey]) => el('button', {
                key,
                type: 'button',
                role: 'tab',
                'aria-selected': tab === key,
                title: t(hintKey),
                style: S.tab(tab === key),
                onClick: () => setTab(key),
              }, [
                el('span', { key: 'l' }, t(labelKey)),
                el('span', { key: 'c', style: S.tabCount(tab === key) }, String(view.counts[key] ?? 0)),
              ]))))

            const [, labelKey, hintKey] = TABS.find(([key]) => key === tab) ?? TABS[0]
            children.push(el('div', { key: 'repoHint', style: S.repoHint }, t(hintKey)))

            // 项目级：按工作区筛选。列表数据里已带 projectPath / projectTitle。
            if (tab === 'project') {
              const projects = state.data.projects ?? []
              if (projects.length > 0) {
                children.push(el('div', { key: 'ws', style: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 } }, [
                  el('span', { key: 'lbl', style: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)' } }, t('chooseProject')),
                  el('select', {
                    key: 'sel', value: workspace,
                    onChange: (e) => setWorkspace(e.target.value),
                    style: { ...S.search, width: 280 },
                  }, [
                    el('option', { key: 'all', value: '' }, t('allProjects')),
                    ...projects.map((pr) => el('option', { key: pr.path, value: pr.path },
                      (pr.title && pr.title !== pr.path ? pr.title + ' — ' : '') + pr.path)),
                  ]),
                ]))
              }
            }

            if (view.shown === 0) {
              children.push(el('div', { key: 'em', style: S.muted },
                view.total === 0 ? t('empty') : t('emptyFiltered')))
            }
            // 诊断：注册表快照不完整时把原因亮出来，不让人对着空列表猜。
            const errs = state.data.errors ?? []
            if (errs.length > 0) {
              children.push(el('div', { key: 'diag', style: { ...S.panel, marginTop: 8 } },
                errs.map((e, i) => el('div', { key: i, style: S.panelText }, 'diag: ' + e))))
            }

            children.push(el('div', { key: 'list', style: S.repo },
              view.current.map((skill) => {
                const k = keyOf(skill)
                return el(SkillCard, {
                  key: k, skill, t,
                  busy: Boolean(busy[k]),
                  confirming: Boolean(confirming[k]),
                  onMode: (mode) => void setMode(skill, mode),
                  onPreview: () => void openPreview(skill),
                  onAskRemove: () => { setConfirming((p) => ({ ...p, [k]: true })); setNotice(null) },
                  onCancelRemove: () => setConfirming((p) => ({ ...p, [k]: false })),
                  onConfirmRemove: () => void removeSkill(skill),
                  onPromote: () => void promoteSkill(skill),
                })
              })))
          }

          return el('div', { style: S.page }, children)
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
            }

            const Page = (props) => {
              const liveState = useLive()
              return el(SkillRepoPage, { ...props, t, namespace: liveState.namespace })
            }

            // 主面板：左侧栏图标点开后的整页内容。
            ctx.slots.inject('main', function* () {
              yield ctx.slots.register({
                name: 'main',
                key: PANEL_ID,
                locale: LOCALE_NS,
                inject: () => ({}),
              }, Page)
            })

            // 左侧栏入口图标。
            // 注意：sidebar.panellist 只负责「图标本身」，侧边栏提供按钮外壳与 label。
            // 点击切换面板必须由注册者自己做——通过 ctx.layout.selectPanel。
            ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
              name: 'sidebar.panellist',
              id: PANEL_ID,
              order: 20,
              label: () => t('panel'),
              locale: LOCALE_NS,
            }, function SkillsPanelIcon() {
              const open = () => {
                try {
                  ctx.layout?.selectPanel?.(PANEL_ID)
                } catch (error) {
                  DIAG('layout', String((error && error.message) || error))
                }
              }
              return el('span', {
                role: 'button',
                tabIndex: 0,
                title: t('panel'),
                onClick: open,
                onKeyDown: (event) => {
                  if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); open() }
                },
                style: {
                  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                  width: 24, height: 24, fontSize: 15, cursor: 'pointer',
                  borderRadius: 6,
                },
                'aria-hidden': 'false',
              }, '\u25c8')
            }))
          } catch (error) {
            DIAG('apply', String((error && error.message) || error) + '\n' + ((error && error.stack) || ''))
            throw error
          }
        }

        // layout 是「可选」依赖：没有它时页面仍可渲染，只是图标点击无法切面板。
        return { inject: ['slots', 'locale', 'remote', 'layout'], apply }
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