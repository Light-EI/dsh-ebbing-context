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
      // 不写死"改哪个文件"（配置入口随安装方式与预设而变），但要说清"关的是什么"，
      // 并直接给一句可以复制给助手/模型的话——用户不必自己去找配置文件。
      note: '使用注意：如果这套 DSH 开着自带的自动压缩（compaction-basic 的自动压缩，默认在上下文用到约 80% 时自己触发），建议关掉它。它一旦触发，会把这里的多层摘要重新拍平成一段总摘要，原来的细节永久丢失；插件本身不受影响、照常能压，但效果会打折扣。要关的是「自动压缩」这个行为（通常是一个 auto 之类的开关，或直接停用那个插件），不关也行、只是效果打折。具体在哪一行、怎么改取决于你的安装方式与预设，插件不会替你改宿主配置。不想自己找的话，可以把这句发给你的助手或模型：「帮我关掉 DeepSeek Harness 自带的自动压缩（compaction-basic 的 auto），改完告诉我你动了哪个文件、怎么改回去」，让它去查；也可以先问问它这个功能是做什么的再决定。',
    }

    // 每一项：分组、标签、路径、类型、范围、详情
    const FIELDS = [
      {
        group: '配额', label: 'L1 占比', path: ['budget', 'l1'], kind: 'number', step: 0.01, min: 0, max: 1,
        detail: '第一层把「原文」折成块，整层合计最多占可用输入的比例。0.10 表示最多占 10%。三层加起来不要超过 0.30。',
      },
      {
        group: '配额', label: 'L2 占比', path: ['budget', 'l2'], kind: 'number', step: 0.01, min: 0, max: 1,
        detail: '第二层把「L1 块」再折一次，整层合计最多占可用输入的比例。',
      },
      {
        group: '配额', label: 'L3 占比', path: ['budget', 'l3'], kind: 'number', step: 0.01, min: 0, max: 1,
        detail: '第三层只放关键词句，用来保住任务目标、约束和结论。整层合计最多占可用输入的比例。',
      },
      {
        group: '单块上限', label: 'L1 单块上限', path: ['segment', 'l1'], kind: 'number', step: 100, min: 64,
        detail: '一个 L1 块正文最多多少 token（按等效 token 算：中文 1 字约 1）。超了这次调用会被整批拒绝，拒绝里给出实际值与上限；怎么调整由模型自己判断（换一段更小的范围、或分几次压），不要为了塞进上限删内容。',
      },
      {
        group: '单块上限', label: 'L2 单块上限', path: ['segment', 'l2'], kind: 'number', step: 100, min: 64,
        detail: '一个 L2 块正文最多多少 token。超过同样整批拒绝，并给出实际值与上限。',
      },
      {
        group: '单块上限', label: 'L3 单块上限', path: ['segment', 'l3'], kind: 'number', step: 100, min: 64,
        detail: '一个 L3 块正文最多多少 token。压 l2 时新块追加在 L3 区末尾、旧 L3 块不动；压 l3 时整个 L3 区并成一块，旧块一起并进去——所以这一块的上限也决定了 L3 区最后一次压缩能留下多少。',
      },
      {
        group: '单块上限', label: '块标题上限', path: ['title', 'maxTokens'], kind: 'number', step: 5, min: 4,
        detail: '每个块正文首行那个标题最多多少 token。标题是模型之后认块用的，太短会认错，太长浪费。',
      },
      {
        group: '提醒', label: '开启提醒', path: ['notice', 'enabled'], kind: 'boolean',
        detail: '提醒的总开关。开着时，插件在每一轮收尾（该叫醒时把模型叫醒）递一条提醒并附上当前地图，让模型自己决定压不压——它从不替模型压缩。关掉就完全不提醒，压缩本身不受影响。',
      },
      {
        group: '提醒', label: '增长提醒阈值', path: ['notice', 'growthTokens'], kind: 'number', step: 1000, min: 0,
        detail: '到线之前的另一条路：自上次提醒后又长了这么多 token 就提醒一次，即使总量还没到线。写 0 只关掉这一条（到线与某层超出设计占比仍会提醒）。长到这个数却一层都压不动时，门槛会自动砍到一半、基线前移，再长半个门槛就重新判一次。',
      },
      {
        group: '提醒', label: '不压之后门槛重设到原额的百分比', path: ['notice', 'growthResetPct'], kind: 'number', step: 10, min: 0, max: 100,
        detail: '增长提醒发出去之后，模型如果决定这一轮不压（内容还没做完、或者比较重要），下一个门槛就按原额的百分之多少重设。40（默认）= 原额 60000 的话，再长 24000 才重新触发；100 = 全额重攒；0 = 下一轮立刻再触发。只影响「又长了」这条触发，不影响到线提醒。增长到量但一层都压不动时走另一条路：门槛固定降到一半、基线前移，再长半个门槛重新判一次，直到某次真压得动为止。',
      },
      {
        group: '提醒', label: '子代理也参与', path: ['notice', 'notifySubagents'], kind: 'boolean',
        detail: '开（默认）：子代理按同一套规则被标记与叫醒。它也会碰到已压缩的表层，没有轮次标记就看不出「这块盖住了哪几轮」，压过的信息在它眼里等于丢了。关：子代理不叫醒、不写轮次标记、不报红字。',
      },
      {
        group: '提醒', label: '提醒触发占比', path: ['triggerPct'], kind: 'number', step: 0.01, min: 0.1, max: 0.99,
        detail: '那条线画在哪。0.75 表示用到「可用输入」的 75% 开始提醒。可用输入 = 上下文窗口 − 输出预留，不是裸窗口大小。只在越过这条线时提醒一次，停在线上不会每轮重复催；掉到线下（比如压完之后）再越线才会再提醒一次。',
      },
      {
        group: '行为', label: '原文区留住最后几轮', path: ['keepTurns'], kind: 'number', step: 1, min: 1, max: 50,
        detail: '原文区必须留住的最后 N 轮：compress 的 l0 最多只写到「当前轮 − N」。当前轮本来就压不了；这条是给最近几轮留缓冲，免得刚压完就要按事件号取回原文。',
      },
      {
        group: '行为', label: '剪大工具返回', path: ['pruneFirst'], kind: 'boolean',
        detail: '把超大的工具返回剪短，别让它们白占上下文。宿主的 toolResultPruner 是全局服务：任何工具返回只要超过 8192 字符，就把中间挖掉、只留开头 4096 与结尾 1024，并插一句「[... tool result middle pruned ...]」，对所有工具一视同仁（本插件 compress 自己那条返回也一样）。它只动工具返回，不动模型写的摘要、也不动压缩块——块是 user/message，不是 tool/result，所以摘要剪不到；被剪的中间那段的原文仍在会话日志里，可按事件号取回。宿主原本把它当「压缩的前置步骤」：只有它的自动压缩要动手时才叫。关掉宿主自动压缩后，改由本插件在每次压缩前叫一次——不压缩就不剪，模型正在用的内容不会被提前改写。关掉这个开关就完全不剪，原文原样留着。',
      },
      {
        group: '行为', label: '折叠压缩调用记录', path: ['foldCallRecord'], kind: 'boolean',
        detail: '压缩成功后，把「这次调用 compress + 它的返回」一起折成一句短注（说明调过、成功了、压了什么）。摘要正文本来就已经写成顶部的块，留在调用参数里的那份是纯重复。宿主不允许改写助手消息本身，只删调用又会留下孤儿返回，所以这一对只能在下一次请求之前整体换成一句用户消息——代价是你看不到那次调用的完整返回。',
      },
      {
        group: '行为', label: '要求可取回原文', path: ['requireSessionQuery'], kind: 'boolean',
        detail: '它不改变压缩本身：开或关，compress 都照常工作。它只决定「没有取回工具时要不要停用」——开着时，一旦发现没装「会话搜索」，两个工具就停用并说明原因，宁可上下文大着也不做取不回的事；关掉时照常压，代价是压掉的原文按事件号也找不回来了。',
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
