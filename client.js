// 浏览器侧：在「插件」面板的这个 bundle 页里画配置表单。
// 保存走宿主给的 form.mutate（一次提交 = 一个 revision = 一次校验），写回 profile 的 cordis.patch.yml。
// 这里不做任何读文件、不调用模型；只负责把可设置项画出来。

window.__ModuleLoader__.load({
  id: 'dsh-ebbing-context',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect } = React

    const TEXT = {
      title: '上下文压缩',
      hint: '改完点最下面的「保存」；离开页面不保存。',
      loading: '正在读取配置…',
      unavailable: '当前客户端读不到这个插件的配置。',
      readonly: '当前 profile 不允许写入配置。',
      noForm: '这个插件没有声明可编辑的配置。',
      // 宿主侧插件没启动时，面板拿不到 form，页面会永远停在「正在读取配置…」。
      // 那种情况下必须有一句能指向原因的话，否则用户只看到一片空白。
      late: '一直停在这里，说明宿主侧的插件没有启动起来。DSH 日志里会有一条加载错误（搜 import），插件卡片的状态也会停在「未运行」而不是「运行中」。',
      save: '保存',
      saving: '保存中…',
      discard: '放弃修改',
      detail: '详情',
      hide: '收起',
      saved: '已保存。',
      nothing: '没有改动。',
      refused: '宿主拒绝了这次保存，改动没有生效。可能是值超出允许范围，或该字段不允许这样设置。',
      failed: '保存失败：',
      invalid: '这些值不合法，没有提交：',
      // 使用注意：宿主自带的自动压缩一旦触发，会把这里的分层摘要拍平。
      // 放在页面最上方、不折叠——它比任何一个配置项都更容易把人坑到。
      note: '使用注意：建议关闭 DeepSeek Harness 自带的自动压缩（compaction-basic 的 auto，默认在用到 80% 时自动触发）。它一旦触发，会把这里的多层摘要重新拍平成一段高层摘要，原有细节永久丢失。插件本身不受影响、照常能压，但效果会打折扣。关法：在 profile 的 cordis.patch.yml 里给 compaction-basic 那一行写 config: { auto: false }（本机 desktop profile 已经是 false）。',
    }

    // 每一项：分组、标签、路径、类型、范围、详情
    const FIELDS = [
      {
        group: '配额', label: 'L1 占比', path: ['budget', 'l1'], kind: 'number', step: 0.01, min: 0, max: 1,
        detail: '第一层把「原文」折成块，最多占可用输入的比例。0.10 表示最多占 10%。三层加起来不要超过 0.30。',
      },
      {
        group: '配额', label: 'L2 占比', path: ['budget', 'l2'], kind: 'number', step: 0.01, min: 0, max: 1,
        detail: '第二层把「L1 块」再折一次，最多占可用输入的比例。',
      },
      {
        group: '配额', label: 'L3 占比', path: ['budget', 'l3'], kind: 'number', step: 0.01, min: 0, max: 1,
        detail: '第三层只放关键词句，用来保住任务目标、约束和结论。它不会自己长大；只有 L2 并进来时才会变大。',
      },
      {
        group: '单块上限', label: 'L1 单块上限', path: ['segment', 'l1'], kind: 'number', step: 100, min: 64,
        detail: '一个 L1 块正文最多多少 token。超过就要求模型拆成两次压缩，或写短一点。',
      },
      {
        group: '单块上限', label: 'L2 单块上限', path: ['segment', 'l2'], kind: 'number', step: 100, min: 64,
        detail: '一个 L2 块正文最多多少 token。',
      },
      {
        group: '单块上限', label: 'L3 单块上限', path: ['segment', 'l3'], kind: 'number', step: 100, min: 64,
        detail: '一个 L3 块正文最多多少 token。L3 可以有多块，压一次产出一块，旧的原地不动。',
      },
      {
        group: '单块上限', label: '块标题上限', path: ['title', 'maxTokens'], kind: 'number', step: 5, min: 4,
        detail: '每个块正文首行那个标题最多多少 token。标题是模型之后认块用的，太短会认错，太长浪费。',
      },
      {
        group: '提醒', label: '开启提醒', path: ['notice', 'enabled'], kind: 'boolean',
        detail: '三种提醒（到线、增长、某层超预算）的总开关：开着时插件往对话里追加提醒，让模型自己去调压缩工具，不替模型压；关掉就完全不提醒。',
      },
      {
        group: '提醒', label: '增长提醒阈值', path: ['notice', 'growthTokens'], kind: 'number', step: 1000, min: 0,
        detail: '另一个独立触发条件：自上次提醒后上下文又长了这么多 token 就再提醒一次，即使总量还没到线。写 0 只关掉这一条（到线与某层超预算的提醒仍会发）。',
      },
      {
        group: '提醒', label: '提醒触发占比', path: ['triggerPct'], kind: 'number', step: 0.01, min: 0.1, max: 0.99,
        detail: '那条线画在哪。0.75 表示用到「可用输入」的 75% 开始提醒。可用输入 = 上下文窗口 − 输出预留，不是裸窗口大小。',
      },
      {
        group: '行为', label: '原文区留住最后几轮', path: ['keepTurns'], kind: 'number', step: 1, min: 0, max: 50,
        detail: '原文区必须留住的最后 N 轮：compress 的 l0 最多只写到「当前轮 − N」。当前轮本来就压不了；这条是给最近几轮留缓冲，免得刚压完就要按事件号取回原文。',
      },
      {
        group: '行为', label: '压缩前先剪', path: ['pruneFirst'], kind: 'boolean',
        detail: '压缩前先调用宿主自带的「剪大工具结果」：把超长工具结果中间挖掉，只留开头和结尾，并写明中间被剪。原文仍在会话日志里，可用检索工具按事件号捞回。开着能少折一点原文；关掉就直接压完整原文。',
      },
      {
        group: '行为', label: '折叠压缩调用记录', path: ['foldCallRecord'], kind: 'boolean',
        detail: '压缩成功后，把「这次调用 compress + 它的返回」一起折成一句短注（说明调过、成功了、压了什么）。摘要正文本来就已经写成顶部的块，留在调用参数里的那份是纯重复。宿主不允许改写助手消息本身，只删调用又会留下孤儿返回，所以这一对只能在下一次请求之前整体换成一句用户消息——代价是你看不到那次调用的完整返回。',
      },
      {
        group: '行为', label: '要求可取回原文', path: ['requireSessionQuery'], kind: 'boolean',
        detail: '压缩是把原文换成摘要，摘要写坏就没了。DSH 的实验性「会话搜索」插件能按事件号读回原始事件。开着时，一旦发现没装它就直接拒绝压缩并报错，宁可上下文大着也不做不可逆的事；关掉则不管有没有取回工具都允许压。',
      },
      {
        group: '行为', label: '输出预留兜底', path: ['reservedTokens'], kind: 'number', step: 1000, min: 0,
        detail: '读不到宿主的输出预留值时，用它扣减可用窗口。0 表示不扣。注意：宿主能给出预留值时这一项不生效。',
      },
    ]

    function readPath(obj, path) {
      let cur = obj
      for (const k of path) {
        if (cur === null || cur === undefined || typeof cur !== 'object') return undefined
        cur = cur[k]
      }
      return cur
    }

    const keyOf = (item) => item.path.join('.')

    const rowStyle = {
      display: 'flex',
      alignItems: 'flex-start',
      justifyContent: 'space-between',
      gap: '16px',
      padding: '10px 0',
      borderTop: '1px solid color-mix(in srgb, currentColor 12%, transparent)',
    }
    const labelStyle = { fontSize: '13px', fontWeight: 600, lineHeight: '20px' }
    const detailStyle = { fontSize: '12px', opacity: 0.7, marginTop: '6px', lineHeight: '18px', maxWidth: '640px' }
    const inputStyle = {
      width: '104px',
      padding: '4px 8px',
      fontSize: '13px',
      textAlign: 'right',
      color: 'inherit',
      background: 'color-mix(in srgb, currentColor 6%, transparent)',
      border: '1px solid color-mix(in srgb, currentColor 18%, transparent)',
      borderRadius: '6px',
      outline: 'none',
    }
    const groupStyle = { fontSize: '12px', fontWeight: 600, opacity: 0.55, marginTop: '18px', marginBottom: '2px' }
    // 使用注意：常驻、不折叠、不和错误横幅抢位置——它讲的是"会让插件效果打折"的既有事实。
    const noteStyle = {
      fontSize: '12px',
      lineHeight: '19px',
      maxWidth: '640px',
      margin: '10px 0 4px',
      padding: '8px 10px',
      borderRadius: '6px',
      borderLeft: '3px solid color-mix(in srgb, currentColor 30%, transparent)',
      background: 'color-mix(in srgb, currentColor 5%, transparent)',
      opacity: 0.85,
    }
    const linkStyle = {
      fontSize: '12px', opacity: 0.7, background: 'none', border: 'none',
      padding: 0, marginLeft: '8px', cursor: 'pointer', color: 'inherit', textDecoration: 'underline',
    }
    const buttonStyle = (primary, disabled) => ({
      padding: '6px 16px',
      fontSize: '13px',
      fontWeight: 600,
      color: primary ? '#fff' : 'inherit',
      background: primary ? '#247bbf' : 'transparent',
      border: primary ? '1px solid #247bbf' : '1px solid color-mix(in srgb, currentColor 22%, transparent)',
      borderRadius: '8px',
      cursor: disabled ? 'not-allowed' : 'pointer',
      opacity: disabled ? 0.5 : 1,
    })
    const bannerStyle = (kind) => ({
      fontSize: '12px',
      lineHeight: '18px',
      padding: '8px 10px',
      marginBottom: '10px',
      borderRadius: '6px',
      border: '1px solid ' + (kind === 'error' ? 'color-mix(in srgb, #d33 45%, transparent)' : 'color-mix(in srgb, currentColor 18%, transparent)'),
      background: kind === 'error' ? 'color-mix(in srgb, #d33 10%, transparent)' : 'color-mix(in srgb, currentColor 5%, transparent)',
    })

    function ConfigPage(props) {
      const { view, form } = props
      const [draft, setDraft] = useState({})
      const [open, setOpen] = useState({})
      const [banner, setBanner] = useState(null)
      const [busy, setBusy] = useState(false)
      // 「宿主侧根本没起来」和「配置还在路上」在界面上长得一样，靠时间把它们分开。
      const [late, setLate] = useState(false)

      useEffect(() => {
        if (form) return undefined
        const timer = setTimeout(() => setLate(true), 4000)
        return () => clearTimeout(timer)
      }, [form])

      const st = (form && form.state) || {}
      const revision = st.revision

      useEffect(() => { setDraft({}); setBanner(null) }, [revision])

      if (view !== 'page') return null
      // form 由「插件」面板的宿主侧拼出来（{ state, mutate }），插件条目还没进配置目录时它是 undefined：
      // 那是"还没读到"，不是"没有配置项"，别骗用户说没声明。
      if (!form) {
        return h(
          'div',
          { style: { fontSize: '13px', opacity: 0.7, lineHeight: 1.6 } },
          late ? TEXT.late : TEXT.loading,
        )
      }
      if (st.status === 'loading') return h('div', { style: { fontSize: '13px', opacity: 0.7 } }, TEXT.loading)
      if (st.status === 'unavailable') return h('div', { style: { fontSize: '13px', opacity: 0.7 } }, TEXT.unavailable)

      const value = st.value || {}
      const readonly = st.writable === false

      function effective(item) {
        const k = keyOf(item)
        if (Object.prototype.hasOwnProperty.call(draft, k)) return draft[k]
        return readPath(value, item.path)
      }

      function setField(item, next) {
        setBanner(null)
        setDraft((prev) => ({ ...prev, [keyOf(item)]: next }))
      }

      const changed = FIELDS.filter((item) => {
        const k = keyOf(item)
        if (!Object.prototype.hasOwnProperty.call(draft, k)) return false
        const now = readPath(value, item.path)
        // 数字按数值比，不按字符串比：把 0.1 写成 0.10 / 00.1 / 1e-1 提交的还是同一个数，
        // 不该算成"改了一项"。字符串比较只留给空值与非数字种类。
        if (item.kind === 'number') {
          if (now === undefined || now === null) return draft[k] !== ''
          const num = Number(draft[k])
          if (draft[k] === '' || !Number.isFinite(num)) return true
          return num !== Number(now)
        }
        if (now === undefined) return draft[k] !== ''
        return String(draft[k]) !== String(now)
      })

      async function save() {
        if (busy || readonly) return
        if (changed.length === 0) { setBanner({ kind: 'ok', text: TEXT.nothing }); return }

        const bad = []
        const ops = []
        for (const item of changed) {
          const raw = draft[keyOf(item)]
          if (item.kind === 'boolean') {
            ops.push({ op: 'set', path: item.path, value: raw === true })
            continue
          }
          const num = Number(raw)
          if (raw === '' || !Number.isFinite(num)) { bad.push(item.label + '（不是数字）'); continue }
          if (item.min !== undefined && num < item.min) { bad.push(item.label + '（不能小于 ' + item.min + '）'); continue }
          if (item.max !== undefined && num > item.max) { bad.push(item.label + '（不能大于 ' + item.max + '）'); continue }
          ops.push({ op: 'set', path: item.path, value: num })
        }

        if (bad.length > 0) {
          setBanner({ kind: 'error', text: TEXT.invalid + bad.join('；') })
          return
        }

        setBusy(true)
        try {
          const ok = await form.mutate(ops, revision)
          if (ok) {
            setDraft({})
            setBanner({ kind: 'ok', text: TEXT.saved })
          } else {
            setBanner({ kind: 'error', text: TEXT.refused })
          }
        } catch (err) {
          setBanner({ kind: 'error', text: TEXT.failed + (err && err.message ? err.message : String(err)) })
        } finally {
          setBusy(false)
        }
      }

      const control = (item) => {
        const v = effective(item)
        if (item.kind === 'boolean') {
          return h('input', {
            type: 'checkbox',
            checked: v === true,
            disabled: readonly || busy,
            onChange: (e) => setField(item, e.target.checked),
            style: { width: '16px', height: '16px', marginTop: '2px', cursor: readonly ? 'not-allowed' : 'pointer' },
          })
        }
        return h('input', {
          type: 'number',
          value: v === undefined ? '' : String(v),
          disabled: readonly || busy,
          step: item.step,
          min: item.min,
          max: item.max,
          onChange: (e) => setField(item, e.target.value),
          style: inputStyle,
        })
      }

      const groups = []
      for (const item of FIELDS) {
        if (groups.length === 0 || groups[groups.length - 1].name !== item.group) {
          groups.push({ name: item.group, items: [] })
        }
        groups[groups.length - 1].items.push(item)
      }

      return h('div', { style: { fontSize: '13px', color: 'inherit' } },
        h('div', { style: { fontSize: '14px', fontWeight: 600 } }, TEXT.title),
        h('div', { style: { ...detailStyle, marginTop: '2px', marginBottom: '8px' } }, readonly ? TEXT.readonly : TEXT.hint),
        h('div', { style: noteStyle }, TEXT.note),
        banner ? h('div', { style: bannerStyle(banner.kind) }, banner.text) : null,
        groups.map((g) => h('div', { key: g.name },
          h('div', { style: groupStyle }, g.name),
          g.items.map((item) => {
            const k = keyOf(item)
            return h('div', { key: k },
              h('div', { style: rowStyle },
                h('div', null,
                  h('span', { style: labelStyle }, item.label),
                  h('button', {
                    type: 'button',
                    style: linkStyle,
                    onClick: () => setOpen((prev) => ({ ...prev, [k]: !prev[k] })),
                  }, open[k] ? TEXT.hide : TEXT.detail),
                  open[k] ? h('div', { style: detailStyle }, item.detail) : null,
                ),
                control(item),
              ),
            )
          }),
        )),
        h('div', { style: { display: 'flex', gap: '10px', marginTop: '18px', paddingTop: '14px', borderTop: '1px solid color-mix(in srgb, currentColor 12%, transparent)' } },
          h('button', {
            type: 'button',
            style: buttonStyle(true, readonly || busy),
            disabled: readonly || busy,
            onClick: save,
          }, busy ? TEXT.saving : TEXT.save),
          h('button', {
            type: 'button',
            style: buttonStyle(false, readonly || busy || changed.length === 0),
            disabled: readonly || busy || changed.length === 0,
            onClick: () => { setDraft({}); setBanner(null) },
          }, TEXT.discard),
          h('span', { style: { fontSize: '12px', opacity: 0.6, alignSelf: 'center' } },
            changed.length > 0 ? '待保存 ' + changed.length + ' 项' : ''),
        ),
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('plugins.row.config', () => ctx.slots.register({
          name: 'plugins.row.config',
          key: 'dsh-ebbing-context#dsh-ebbing-context',
        }, ConfigPage))
      },
    }
  },
})
