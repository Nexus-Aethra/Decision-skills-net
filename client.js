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
 *
 * 这个文件由宿主的经典 <script> 加载。**顶层必须有环境守卫**：
 * 宿主自身的 boot 审计只报「@local/decision-skills: failed」，不打印原因，
 * 所以任何顶层异常都会表现成「整个 Web 起不来」而看不到线索。
 * DIAG 把每个阶段的失败原样留在控制台。
 */
;(function () {
  const DIAG = (phase, detail) => {
    try { console.error('[decision-skills] ' + phase + ': ' + detail) } catch { /* 没有 console */ }
  }

  if (typeof window === 'undefined' || !window.__ModuleLoader__) {
    DIAG('bootstrap', 'no __ModuleLoader__ (not a browser shell); skipping registration')
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
        const { useEffect, useMemo, useRef, useState } = React

        /** Remote 方法清单：必须与宿主 installSkillManager 的 methods 逐项一致。 */
        const REMOTE_METHODS = ['list', 'listForSession', 'read', 'setEnabled']
        const NS = 'skillManager'
        const LOCALE_NS = 'decisionSkills'
        const SECTION_ID = 'decision-skills'
        const SLOT = 'settings.section'
        const PASS_THROUGH = () => ({ parse: (value) => value })

        /**
         * 方法与 wire 参数的对应关系。**必须与宿主方法的实参个数逐项一致**：
         * Host 网关会拿 descriptor.parameters 去校验 args 的字段集合，
         * 多声明一个参数就报 gateway/arguments-invalid。
         *   list        ()       -> 无参数
         *   read        (file)   -> 一个
         *   setEnabled  (file,..)-> 实际收一个对象
         */
        const METHOD_PARAMS = {
          list: [],
          listForSession: ['request'],
          read: ['request'],
          setEnabled: ['request'],
        }

        /** 手写 typert 贡献描述；外部包走不到生成流水线。 */
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
            // result 不可省略：网关在 invoke() 里直接读 descriptor.result.mode，
            // 缺了它运行期抛 "Cannot read properties of undefined (reading 'mode')"。
            result: {
              mode: 'strict',
              typeSymbol: MODULE_ID + '#' + NS + '/' + method + ':result',
              create: PASS_THROUGH,
            },
          })),
        }

        const zh = {
          meta: { title: '技能管理', description: '浏览系统级与所有工作区的技能，并切换启用状态。' },
          nav: '技能', title: '技能管理',
          subtitle: '系统级与所有工作区的 SKILL.md',
          refresh: '刷新', search: '搜索名称或描述',
          filterAll: '全部', filterEnabled: '已启用', filterDisabled: '已关闭',
          scopeSystem: '系统级', scopeProject: '工作区', scopeBundled: '内置',
          virtualSkill: '（内置资源，无文件路径）',
          readOnly: '内置技能不可开关',
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
          scopeSystem: 'System', scopeProject: 'Workspace', scopeBundled: 'Bundled',
          virtualSkill: '(bundled resource, no file path)',
          readOnly: 'Bundled skills are read-only',
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

        const el = (tag, props, children) => React.createElement(tag, props, children)

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
                el('span', { key: 'b', style: styles.badge }, skill.source),
              ]),
              el('div', { key: 'd', style: styles.skillDesc }, skill.description || t('noDescription')),
              el('div', { key: 'p', style: styles.path }, skill.path || t('virtualSkill')),
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
            // 实参直接就是第一个 wire 参数，不要再包一层 { request }：
            // 多包一层会让 Host 收到 {request:{...}}，参数静默丢失。
            // 参数个数必须与描述符一致：list 是无参方法，传 {} 会被
            // 网关判为 arguments-invalid（args 字段集合不匹配）。
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
            setState({ status: 'loading', data: null, error: null })
            try {
              setState({ status: 'ready', data: await call('list'), error: null })
            } catch (error) {
              setState({ status: 'error', data: null, error: String((error && error.message) || error) })
            }
          }

          useEffect(() => { void load() }, [])

          // 行的身份用 path，bundled 技能没有 path，退回 name。
          const keyOf = (s) => s.path || s.name
          const toggle = async (skill) => {
            const key = keyOf(skill)
            if (!skill.editable) {
              DIAG('setEnabled', 'read-only (bundled): ' + skill.name)
              return
            }
            setBusy((prev) => ({ ...prev, [key]: true }))
            try {
              const outcome = await call('setEnabled', { file: skill.path, enabled: !skill.enabled })
              if (outcome && outcome.ok === false) DIAG('setEnabled', 'host rejected: ' + String(outcome.error))
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
            const keyOf = (s) => s.path || s.name
            const skills = state.data.skills
              .filter((s) => (filter === 'all' ? true : filter === 'enabled' ? s.enabled : !s.enabled))
              .filter((s) => q === '' || s.name.toLowerCase().includes(q)
                || String(s.description || '').toLowerCase().includes(q))
              .map((s) => (preview[keyOf(s)]
                ? { ...s, previewOpen: preview[keyOf(s)].open, previewText: preview[keyOf(s)].text }
                : s))
            // 三个桶：内置(bundled) / 系统级(user, custom, runtime) / 工作区(project)。
            // 每个技能自带 source，按 source 归组，不再猜路径。
            const groups = { bundled: [], system: [], project: [] }
            for (const s of skills) {
              const bucket = groups[s.scope] ?? groups.system
              bucket.push(s)
            }
            return { groups, total: skills.length, probe: state.data.probe ?? [], probeDetail: state.data.probeDetail ?? [] }
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
            if (view.probe && view.probe.length > 0) {
              children.push(el('div', { key: 'pb', style: styles.muted },
                'probe: ' + view.probe.map((p) => (p.title || '(global)') + '=' + String(p.cwd ?? '-')).join(' | ')))
            if (view.probeDetail && view.probeDetail.length > 0) {
              children.push(el('div', { key: 'pd', style: styles.muted },
                'detail: ' + view.probeDetail.map((d) => d.cwd + ' -> ' + d.count + ' [' + JSON.stringify(d.bySource) + ']').join(' || ')))
            }
            }

            const BUCKETS = [
              ['bundled', 'scopeBundled'],
              ['system', 'scopeSystem'],
              ['project', 'scopeProject'],
            ]
            for (const [bucket, labelKey] of BUCKETS) {
              const items = view.groups[bucket]
              if (!items || items.length === 0) continue
              const rowKey = (s) => s.path || s.name
              children.push(el('div', { key: 'g-' + bucket, style: styles.group }, [
                el('div', { key: 'gh', style: styles.groupHead }, t(labelKey) + ' · ' + items.length),
                ...items.map((skill) => el(SkillRow, {
                  key: rowKey(skill), skill, t, busy: Boolean(busy[rowKey(skill)]),
                  onToggle: () => void toggle(skill), onPreview: () => void openPreview(skill),
                })),
              ]))
            }
          }

          return el('div', { style: styles.wrap }, children)
        }

        function apply(ctx) {
          try {
            DIAG('apply', 'entered')
            ctx.effect(() => ctx.locale.register(LOCALE_NS, { zh, en }), 'decision-skills: locales')
            const t = ctx.locale.bind(LOCALE_NS)

            // Remote 命名空间是异步到位的：用订阅驱动重渲染，首帧不读 ctx.remote.X。
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

            // 命名空间服务键是 'remote.<namespace>'；必须走 ctx.get 或
            // 已声明的 ctx['remote.<ns>']，不能用 ctx.remote[NS] 下标访问。
            const SERVICE_KEY = 'remote.' + NS
            const readNamespace = () => {
              try { return ctx.get(SERVICE_KEY) ?? null } catch { return null }
            }

            const remote = ctx.remote
            if (remote && typeof remote.$mount === 'function') {
              // $mount 返回 Promise<disposer>。effect 是同步的，此刻拿不到
              // disposer，所以用稳定引用包装，卸载时才调用真正的那一个。
              const mounted = remote.$mount(TYPERT_REMOTE)
              const disposeRef = { current: null }
              Promise.resolve(mounted).then(
                (disposer) => {
                  disposeRef.current = typeof disposer === 'function' ? disposer : null
                  setNamespace(readNamespace())
                  DIAG('remote', 'mounted, namespace=' + (readNamespace() ? 'ready' : 'missing'))
                },
                (error) => {
                  DIAG('remote', 'mount failed: ' + String((error && error.message) || error))
                  setNamespace(null)
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
            DIAG('apply', 'completed')
          } catch (error) {
            // 这里必须打出来：宿主只会说 "failed"，不给原因。
            DIAG('apply', String((error && error.message) || error) + '\n' + ((error && error.stack) || ''))
            throw error
          }
        }

        // inject 必须是 factory 返回对象的属性。
        // 少了它，cordis 的 ctx proxy 会在访问服务时抛
        //   cannot get property "locale" without inject
        // ——而且是在 apply 执行期抛，整个 Web boot 因此失败。
        // 注意：不要加 'reflect'，它是 cordis 内部对象，不在可注入服务表里，
        // 加了会让插件卡在 pending (waiting for service: reflect)。
        //
        // 绝不能把 'remote.<NS>' 放进 inject：那是**本插件自己**要通过
        // $mount 注册的命名空间，此刻还不存在。声明它会让 fiber 永远停在
        //   pending (waiting for service: remote.skillManager)
        // 并且把整个 web boot 拖死。正确做法是只声明 'remote'，等挂载完成
        // 后再用 ctx.get('remote.<NS>') 现取。
        return { inject: ['slots', 'locale', 'remote'], apply }
      },
    })
  } catch (error) {
    // 重复执行是宿主的正常行为（batch + 回退），只有 duplicate 可以吞掉。
    const message = String((error && error.message) || error)
    if (message.includes('duplicate factory registration')) {
      DIAG('bootstrap', 'duplicate registration ignored')
    } else {
      DIAG('bootstrap', message)
      throw error
    }
  }
})()
