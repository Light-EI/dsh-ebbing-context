// 浏览器侧：在「插件」面板的这个 bundle 页里画配置表单。
// 保存走宿主给的 form.mutate（一次提交 = 一个 revision = 一次校验），写回 profile 的 cordis.patch.yml。
// 这里不做任何读文件、不调用模型；只负责把可设置项画出来。
// 界面语言跟随宿主：中文环境只显示中文、英文环境只显示英文（两套文案都要维护，见维护手册 §1.30）。

window.__ModuleLoader__.load({
  id: 'dsh-ebbing-context',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useMemo } = React

    const TEXT = {
      zh: {
        title: 'EC上下文设置',
        hint: '改完点最下面的「保存」；离开页面不保存。',
        loading: '正在读取配置…',
        unavailable: '当前客户端读不到这个插件的配置。',
        readonly: '当前 profile 不允许写入配置。',
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
        note: '使用注意：如果这套 DSH 开着自带的自动压缩（compaction-basic 的自动压缩，默认在上下文用到约 80% 时自己触发），建议关掉它。它一旦触发，会把这里的多层摘要重新拍平成一段总摘要，分层结构就没了——详细内容要从会话日志里按事件号翻回来，模型不会再看到这些块；插件本身不受影响、照常能压，但效果会打折扣。要关的是「自动压缩」这个行为（通常是一个 auto 之类的开关，或直接停用那个插件），不关也行、只是效果打折。具体在哪一行、怎么改取决于你的安装方式与预设，插件不会替你改宿主配置。不想自己找的话，可以把这句发给你的助手或模型：「帮我关掉 DeepSeek Harness 自带的自动压缩（compaction-basic 的 auto），改完告诉我你动了哪个文件、怎么改回去」，让它去查；也可以先问问它这个功能是做什么的再决定。',
      },
      en: {
        title: 'Ebbing Context',
        hint: 'Click "Save" at the bottom when done; leaving this page discards changes.',
        loading: 'Reading configuration…',
        unavailable: 'This client cannot read this plugin\'s configuration.',
        readonly: 'This profile does not allow configuration writes.',
        late: 'Stuck here means the host-side plugin did not start. The DSH log will contain a load error (search for "import"), and the plugin card will stay at "not running" instead of "running".',
        save: 'Save',
        saving: 'Saving…',
        discard: 'Discard changes',
        detail: 'Details',
        hide: 'Hide',
        saved: 'Saved.',
        nothing: 'No changes.',
        refused: 'The host rejected this save, so nothing was applied. A value may be out of the allowed range, or this field may not be settable this way.',
        failed: 'Save failed: ',
        invalid: 'These values were not submitted: ',
        note: 'Note: if this DSH installation has the host\'s built-in auto-compaction enabled (compaction-basic\'s auto, triggered by default at about 80% of the context), turning it off is recommended. Once it fires it re-flattens these layered summaries into one big summary and the layered structure is gone — details would have to be read back from the session log by event number, and the model will not see these blocks any more. The plugin itself is unaffected and still compresses, just with a discount. What you want to turn off is the "auto-compaction" behavior (usually an auto switch, or simply disabling that plugin); leaving it on is fine too, just with the discount. Which line to change and how depends on your install method and preset — the plugin will not touch host configuration for you. If you would rather not hunt for it, send this to your assistant or model: "Turn off DeepSeek Harness\'s built-in auto-compaction (compaction-basic\'s auto), and tell me which file you changed and how to revert it", and let it look; you can also ask what the feature does first and then decide.',
      },
    }

    // 设置面板里的标题跟宿主语言走：中文「EC上下文设置」、英文「Ebbing Context」。
    // 只认一个判据（宿主 locale 的 active），正文与标题不会分叉；拿不到 locale 服务时退回中文。
    let localeApi = null // 用来读 active、订阅语言切换；在 apply 里从 ctx.get('locale') 取
    const activeLocale = () => {
      try {
        const snap = localeApi && typeof localeApi.getLocale === 'function' ? localeApi.getLocale() : null
        return snap && snap.active ? String(snap.active) : 'zh'
      } catch {
        return 'zh'
      }
    }
    const pageTitle = () => (activeLocale().startsWith('zh') ? TEXT.zh.title : TEXT.en.title)

    // 每一项：分组、标签、路径、类型、范围、详情（中英各一份，行为完全一致）
    const FIELDS = [
      {
        group: '配额', groupEn: 'Quota', label: 'L1 占比', labelEn: 'L1 share', path: ['budget', 'l1'], kind: 'number', step: 0.01, min: 0, max: 1,
        detail: '第一层把「原文」折成块，整层合计最多占实际输入上限的比例。0.10 表示最多占 10%。三层合计默认 0.19（10% + 6% + 3%）；调大后留给原文的空间会变小。',
        detailEn: 'The first layer folds raw text into blocks; this caps the whole layer as a share of the actual input limit. 0.10 means at most 10%. The three layers total 0.19 by default (10% + 6% + 3%); raising them leaves less room for raw text.',
      },
      {
        group: '配额', groupEn: 'Quota', label: 'L2 占比', labelEn: 'L2 share', path: ['budget', 'l2'], kind: 'number', step: 0.01, min: 0, max: 1,
        detail: '第二层把「L1 块」再折一次，整层合计最多占实际输入上限的比例。',
        detailEn: 'The second layer folds L1 blocks again; this caps the whole layer as a share of the actual input limit.',
      },
      {
        group: '配额', groupEn: 'Quota', label: 'L3 占比', labelEn: 'L3 share', path: ['budget', 'l3'], kind: 'number', step: 0.01, min: 0, max: 1,
        detail: '第三层只放关键词句，用来保住任务目标、约束和结论。整层合计最多占实际输入上限的比例。',
        detailEn: 'The third layer keeps only keywords and key sentences, preserving task goals, constraints and conclusions; this caps the whole layer as a share of the actual input limit.',
      },
      {
        group: '单块上限', groupEn: 'Block limit', label: 'L1 单块上限', labelEn: 'L1 block limit', path: ['segment', 'l1'], kind: 'number', step: 100, min: 64,
        detail: '一个 L1 块正文最多多少 token（按等效 token 算：中文 1 字约 0.6、英文 1 字约 0.3）。超了这次调用会被整批拒绝，拒绝里给出实际值与上限；怎么调整由模型自己判断（换一段更小的范围再压），不要为了塞进上限删内容。',
        detailEn: 'Maximum tokens of one L1 block body (equivalent-token basis: about 0.6 per Chinese character, 0.3 per English character). If exceeded, the whole call is rejected and the rejection reports the actual value and the limit; the model decides how to adjust (compress a smaller range), and must not delete content just to fit.',
      },
      {
        group: '单块上限', groupEn: 'Block limit', label: 'L2 单块上限', labelEn: 'L2 block limit', path: ['segment', 'l2'], kind: 'number', step: 100, min: 64,
        detail: '一个 L2 块正文最多多少 token。超过同样整批拒绝，并给出实际值与上限。',
        detailEn: 'Maximum tokens of one L2 block body. Exceeding it likewise rejects the whole batch and reports the actual value and the limit.',
      },
      {
        group: '单块上限', groupEn: 'Block limit', label: 'L3 单块上限', labelEn: 'L3 block limit', path: ['segment', 'l3'], kind: 'number', step: 100, min: 64,
        detail: '一个 L3 块正文最多多少 token。压 l2 时新块追加在 L3 区末尾、旧 L3 块不动；压 l3 时整个 L3 区并成一块，旧块一起并进去——所以这一块的上限也决定了 L3 区最后一次压缩能留下多少。',
        detailEn: 'Maximum tokens of one L3 block body. Compressing l2 appends a new block at the end of the L3 region (old L3 blocks stay); compressing l3 folds the whole L3 region into one block, old blocks included — so this limit also decides how much the final L3 compaction can keep.',
      },
      {
        group: '单块上限', groupEn: 'Block limit', label: '块标题上限', labelEn: 'Block title limit', path: ['title', 'maxTokens'], kind: 'number', step: 5, min: 4,
        detail: '每个块正文首行那个标题最多多少 token。标题是模型之后认块用的，太短会认错，太长浪费。',
        detailEn: 'Maximum tokens of the title on the first line of a block. The model uses titles to recognize blocks later: too short and it misidentifies them, too long wastes tokens.',
      },
      {
        group: '提醒', groupEn: 'Reminders', label: '开启提醒', labelEn: 'Enable reminders', path: ['notice', 'enabled'], kind: 'boolean',
        detail: '提醒的总开关。开着时，插件在每一轮收尾（该叫醒时把模型叫醒）递一条提醒并附上当前地图，让模型自己决定压不压——它从不替模型压缩。关掉就完全不提醒，压缩本身不受影响。',
        detailEn: 'Master switch for reminders. When on, at the end of each turn (when it is time) the plugin wakes the model with a reminder and the current map, and the model decides whether to compress — it never compresses on the model\'s behalf. Off means no reminders at all; compression itself is unaffected.',
      },
      {
        group: '提醒', groupEn: 'Reminders', label: '增长提醒阈值', labelEn: 'Growth reminder threshold', path: ['notice', 'growthTokens'], kind: 'number', step: 1000, min: 0,
        detail: '到线之前的另一条路：自上次提醒后又长了这么多 token 就提醒一次，即使总量还没到线。写 0 只关掉这一条（到线与某层超出设计占比仍会提醒）。长到这个数却一层都压不动时，门槛会自动砍到一半、基线前移，再长半个门槛就重新判一次。',
        detailEn: 'A second path besides the usage line: remind once the session has grown by this many tokens since the last reminder, even before the total hits the line. 0 disables only this path (the usage line and per-layer quota still remind). If the threshold is reached but no layer can be compressed, the threshold is halved and the baseline moves forward, then another half-threshold of growth re-evaluates.',
      },
      {
        group: '提醒', groupEn: 'Reminders', label: '模型主动拒绝之后门槛重设到原额的百分比', labelEn: 'Threshold reset after the model declines (%)', path: ['notice', 'growthResetPct'], kind: 'number', step: 10, min: 0, max: 100,
        detail: '增长提醒发出去之后，模型如果决定这一轮不压（内容还没做完、或者比较重要），下一个门槛就按原额的百分之多少重设。40（默认）= 原额 65000 的话，再长 26000 才重新触发；100 = 全额重攒；0 = 门槛降到 1 token，下一轮只要再长一点就重新触发。只影响「又长了」这条触发，不影响到线提醒。增长到量但一层都压不动时走另一条路：门槛固定降到一半、基线前移，再长半个门槛重新判一次，直到某次真压得动为止。',
        detailEn: 'After a growth reminder goes out, if the model decides not to compress this turn (content unfinished or important), the next threshold is reset to this percentage of the original. 40 (default) = with an original threshold of 65000, another 26000 tokens are needed to trigger again; 100 = save the full amount again; 0 = the threshold drops to 1 token, so the next bit of growth triggers again. Only affects the "grew again" path, not the usage line. When growth has occurred but no layer can be compressed, another path applies: the threshold halves and the baseline moves forward, re-evaluated every half-threshold until a compaction actually succeeds.',
      },
      {
        group: '提醒', groupEn: 'Reminders', label: '子代理也参与', labelEn: 'Include subagents', path: ['notice', 'notifySubagents'], kind: 'boolean',
        detail: '开（默认）：子代理按同一套规则被标记与叫醒。它也会碰到已压缩的表层，没有轮次标记就看不出「这块盖住了哪几轮」，压过的信息在它眼里等于丢了。关：子代理不叫醒、不写轮次标记、不报红字。',
        detailEn: 'On (default): subagents are marked and woken by the same rules. They also see compressed surfaces; without turn markers they cannot tell which turns a block covers, so compressed information is effectively lost to them. Off: subagents are not woken, no turn markers are written, no red errors.',
      },
      {
        group: '提醒', groupEn: 'Reminders', label: '提醒触发占比', labelEn: 'Reminder trigger share', path: ['triggerPct'], kind: 'number', step: 0.01, min: 0.1, max: 0.99,
        detail: '那条线画在哪。0.75 表示用到「实际输入上限」的 75% 开始提醒。实际输入上限 = 上下文窗口 − 输出预留，不是裸窗口大小。只在越过这条线时提醒一次，停在线上不会每轮重复催；掉到线下（比如压完之后）再越线才会再提醒一次。',
        detailEn: 'Where the line is drawn. 0.75 means start reminding at 75% of the actual input limit. Actual input limit = context window − output reserve, not the raw window size. It reminds once when crossing the line; staying above it does not nag every turn; dropping below (e.g. after compaction) and crossing again reminds once more.',
      },
      {
        group: '行为', groupEn: 'Behavior', label: '原文区留住最后几轮', labelEn: 'Raw turns kept', path: ['keepTurns'], kind: 'number', step: 1, min: 1, max: 50,
        detail: '原文区必须留住的最后 N 轮：compress 的 l0 最多只写到「当前轮 − 1 − N」。当前轮本来就压不了；这条是给最近几轮留缓冲，免得刚压完就要按事件号取回原文。',
        detailEn: 'The last N turns the raw region must keep: compress l0 can only write up to "current turn − 1 − N". The current turn can never be compressed; this buffer keeps the most recent turns intact so raw text does not have to be fetched back by event number right after a compaction.',
      },
      {
        group: '行为', groupEn: 'Behavior', label: '剪大工具返回', labelEn: 'Prune large tool results', path: ['pruneFirst'], kind: 'boolean',
        detail: '把超大的工具返回剪短，别让它们白占上下文。宿主的 toolResultPruner 是全局服务：任何工具返回只要超过 8192 字符，就把中间挖掉、只留开头 4096 与结尾 1024，并插一句「[... tool result middle pruned ...]」，对所有工具一视同仁（本插件 compress 自己那条返回也一样）。它只动工具返回，不动模型写的摘要、也不动压缩块——块是 user/message，不是 tool/result，所以摘要剪不到；被剪的中间那段的原文仍在会话日志里，可按事件号取回。宿主原本把它当「压缩的前置步骤」：只有它的自动压缩要动手时才叫。关掉宿主自动压缩后，改由本插件在每次压缩前叫一次——不压缩就不剪，模型正在用的内容不会被提前改写。关掉这个开关就完全不剪，原文原样留着。',
        detailEn: 'Shorten oversized tool results so they do not take up space for nothing. The host\'s toolResultPruner is a global service: any tool result over 8192 characters has its middle cut out, keeping the first 4096 and last 1024, with "[... tool result middle pruned ...]" inserted — for all tools alike (including this plugin\'s own compress return). It only touches tool results, never model-written summaries or compressed blocks (blocks are user/message, not tool/result, so summaries are never pruned); the pruned middle stays in the session log and is retrievable by event number. The host originally called it as a "pre-step of compaction", only when its own auto-compaction was about to act. With host auto-compaction off, this plugin calls it once before each compression — no compression, no pruning, so content the model is using is not rewritten early. Turn this switch off to disable pruning entirely; raw text stays as is.',
      },
      {
        group: '行为', groupEn: 'Behavior', label: '折叠压缩调用记录', labelEn: 'Fold compaction call records', path: ['foldCallRecord'], kind: 'boolean',
        detail: '压缩成功后，把「这次调用 compress + 它的返回」一起折成一句短注（说明调过、成功了、压了什么）。摘要正文本来就已经写成顶部的块，留在调用参数里的那份是纯重复。宿主不允许改写助手消息本身，只删调用又会留下孤儿返回，所以这一对只能在下一次请求之前整体换成一句用户消息——代价是你看不到那次调用的完整返回。',
        detailEn: 'After a successful compaction, fold "this compress call + its return" into one short note (saying it was called, succeeded, and what was compressed). The summary body is already at the top as a block, so the copy in the call arguments is pure duplication. The host does not allow rewriting assistant messages, and deleting only the call would leave an orphan result, so the pair is replaced as a whole with one user message before the next request — at the cost of not seeing that call\'s full return.',
      },
      {
        group: '行为', groupEn: 'Behavior', label: '要求可取回原文', labelEn: 'Require raw-text retrieval', path: ['requireSessionQuery'], kind: 'boolean',
        detail: '它不改变压缩本身：开或关，compress 都照常工作。它只决定「没有取回工具时要不要停用」——开着时，一旦发现没装「会话搜索」，两个工具就停用并说明原因，提醒也不再叫醒，宁可上下文大着也不做取不回的事；关掉时照常压；能不能按事件号查回来，取决于这台机器装没装会话搜索。',
        detailEn: 'Does not change compaction itself: on or off, compress works as usual. It only decides whether to disable when the retrieval tool is missing: when on, if "session search" is not installed, both tools are disabled with the reason, reminders stop, and the context is left large rather than compacting something that cannot be retrieved; when off, compaction proceeds as usual, and whether it can be looked up by event number depends on whether session search is installed on this machine.',
      },
      {
        group: '行为', groupEn: 'Behavior', label: '输出预留兜底', labelEn: 'Output reserve fallback', path: ['reservedTokens'], kind: 'number', step: 1000, min: 0,
        detail: '读不到宿主的输出预留值时，用它扣减实际输入上限。0 表示不扣。注意：宿主能给出预留值时这一项不生效。',
        detailEn: 'Used to subtract from the actual input limit when the host\'s output reserve value cannot be read. 0 means subtract nothing. Note: this has no effect when the host provides the reserve value.',
      },
    ]

    // 设置面板左侧导航的独立页要读写的命名空间 = profile 里 Loader 行的入口 id。
    // 不是包名、也不是「插件」页的 slot key（`<包名>#<行 id>`）；这条 id 写在
    // dsh.bundle.patch.yml 的 insert 行里，和插件行 id 相同。改安装方式时这里要跟着改。
    const CONFIG_NS = 'dsh-ebbing-context'

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
      // 宿主语言切换时重画标题（「插件」页那一份没有 locale 注入，只能自己订阅）。
      const [, bumpLocale] = useState(0)
      useEffect(() => {
        if (!localeApi || typeof localeApi.subscribe !== 'function') return undefined
        return localeApi.subscribe(() => bumpLocale((n) => n + 1))
      }, [])

      useEffect(() => {
        if (form) return undefined
        const timer = setTimeout(() => setLate(true), 4000)
        return () => clearTimeout(timer)
      }, [form])

      // 界面只显示当前语言（跟随宿主 locale），不再中英同屏。
      // 字段的 label/detailEn、TEXT.zh/TEXT.en 仍然两套都保留——改文案时两边都要改。
      const zh = activeLocale().startsWith('zh')
      const T = zh ? TEXT.zh : TEXT.en

      const st = (form && form.state) || {}
      const revision = st.revision

      useEffect(() => { setDraft({}); setBanner(null) }, [revision])

      if (view !== 'page') return null
      // form 由「插件」面板的宿主侧拼出来（{ state, mutate }），插件条目还没进配置目录时它是 undefined：
      // 那是"还没读到"，不是"没有配置项"，别骗用户说没声明。
      if (!form) {
        return h('div', { style: { fontSize: '13px', opacity: 0.7, lineHeight: 1.6 } },
          late ? T.late : T.loading)
      }
      if (st.status === 'loading') {
        return h('div', { style: { fontSize: '13px', opacity: 0.7 } }, T.loading)
      }
      if (st.status === 'unavailable') {
        return h('div', { style: { fontSize: '13px', opacity: 0.7 } }, T.unavailable)
      }

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
        if (changed.length === 0) { setBanner({ kind: 'ok', zh: TEXT.zh.nothing, en: TEXT.en.nothing }); return }

        const bad = []
        const ops = []
        for (const item of changed) {
          const raw = draft[keyOf(item)]
          if (item.kind === 'boolean') {
            ops.push({ op: 'set', path: item.path, value: raw === true })
            continue
          }
          const num = Number(raw)
          if (raw === '' || !Number.isFinite(num)) {
            bad.push({ zh: item.label + '（不是数字）', en: item.labelEn + ' (not a number)' })
            continue
          }
          if (item.min !== undefined && num < item.min) {
            bad.push({ zh: item.label + '（不能小于 ' + item.min + '）', en: item.labelEn + ' (must be ≥ ' + item.min + ')' })
            continue
          }
          if (item.max !== undefined && num > item.max) {
            bad.push({ zh: item.label + '（不能大于 ' + item.max + '）', en: item.labelEn + ' (must be ≤ ' + item.max + ')' })
            continue
          }
          ops.push({ op: 'set', path: item.path, value: num })
        }

        if (bad.length > 0) {
          setBanner({
            kind: 'error',
            zh: TEXT.zh.invalid + bad.map((b) => b.zh).join('；'),
            en: TEXT.en.invalid + bad.map((b) => b.en).join('; '),
          })
          return
        }

        setBusy(true)
        try {
          const ok = await form.mutate(ops, revision)
          if (ok) {
            setDraft({})
            setBanner({ kind: 'ok', zh: TEXT.zh.saved, en: TEXT.en.saved })
          } else {
            setBanner({ kind: 'error', zh: TEXT.zh.refused, en: TEXT.en.refused })
          }
        } catch (err) {
          const msg = err && err.message ? err.message : String(err)
          setBanner({ kind: 'error', zh: TEXT.zh.failed + msg, en: TEXT.en.failed + msg })
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
          groups.push({ name: item.group, nameEn: item.groupEn, items: [] })
        }
        groups[groups.length - 1].items.push(item)
      }

      return h('div', { style: { fontSize: '13px', color: 'inherit' } },
        h('div', { style: { fontSize: '14px', fontWeight: 600 } }, pageTitle()),
        h('div', { style: { ...detailStyle, marginTop: '2px', marginBottom: '8px' } },
          readonly ? T.readonly : T.hint),
        h('div', { style: noteStyle }, T.note),
        banner ? h('div', { style: bannerStyle(banner.kind) }, zh ? banner.zh : banner.en) : null,
        groups.map((g) => h('div', { key: g.name },
          h('div', { style: groupStyle }, zh ? g.name : g.nameEn),
          g.items.map((item) => {
            const k = keyOf(item)
            return h('div', { key: k },
              h('div', { style: rowStyle },
                h('div', null,
                  h('span', { style: labelStyle }, zh ? item.label : item.labelEn),
                  h('button', {
                    type: 'button',
                    style: linkStyle,
                    onClick: () => setOpen((prev) => ({ ...prev, [k]: !prev[k] })),
                  }, open[k] ? T.hide : T.detail),
                  open[k] ? h('div', { style: detailStyle }, zh ? item.detail : item.detailEn) : null,
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
          }, busy ? T.saving : T.save),
          h('button', {
            type: 'button',
            style: buttonStyle(false, readonly || busy || changed.length === 0),
            disabled: readonly || busy || changed.length === 0,
            onClick: () => { setDraft({}); setBanner(null) },
          }, T.discard),
          h('span', { style: { fontSize: '12px', opacity: 0.6, alignSelf: 'center' } },
            changed.length > 0 ? (zh ? '待保存 ' + changed.length + ' 项' : changed.length + ' unsaved') : ''),
        ),
      )
    }

    return {
      // 只硬依赖 slots（两个入口都靠它）；configForms / locale 用 ctx.inject 等宿主提供后再接：
      // 缺失时降级——插件行配置页照常工作、设置页不出现、标题退回中文，
      // 不会因为新服务缺失让整个 client 半侧不激活（配置页凭空消失）。
      // 假设宿主 cordis 4 的 ctx.inject 存在（本插件最低宿主即 4；该方法缺失时 apply 会抛）。
      inject: ['slots'],
      apply(ctx) {
        // 每次 apply 都先复位：插件被重载/停用后不能留着上一份宿主 runtime 的引用。
        localeApi = null

        // 标题跟宿主语言走；只读 active，不注册词典（标题和正文用同一个判据）。
        // 用 ctx.inject 而不是 ctx.get：服务如果比本插件晚就位，回调会等它出现再跑。
        ctx.inject(['locale'], (scope) => {
          scope.effect(() => {
            localeApi = scope.locale && typeof scope.locale.getLocale === 'function' ? scope.locale : null
            return () => { localeApi = null }
          }, 'ebbing-context: locale')
        })

        // 「内置插件」→ 本插件 → 配置：保留。和设置面板里的页编辑同一份配置。
        ctx.slots.inject('plugins.row.config', () => ctx.slots.register({
          name: 'plugins.row.config',
          key: 'dsh-ebbing-context#dsh-ebbing-context',
        }, ConfigPage))

        // 设置弹窗左侧导航里的独立页（和「通知提醒」同一层）。不能往别的插件注册的页里塞行：
        // settings.section 的 ownerProps 只有 close，dsh-notify-me 的页也没有留子槽；
        // 所以自己占一项，数据走 configForms.get(入口 id) 的共享读写队列。
        // 同时等 configForms 与 locale：设置页第一次渲染就要拿到正确语言（宿主 locale 的 apply
        // 是 async、可能晚于本插件；缺一个就整页不挂，不拿中文顶替）。行页不受影响。
        // whileServed：宿主没把这条命名空间发出来时（例如插件被停用）页面不出现，
        // 不会留一个点开就报「读不到配置」的空页。
        ctx.inject(['configForms', 'locale'], (scope) => {
          const forms = scope.configForms
          if (!forms || typeof forms.get !== 'function' || typeof forms.whileServed !== 'function') return
          localeApi = scope.locale && typeof scope.locale.getLocale === 'function' ? scope.locale : null
          const formController = forms.get(CONFIG_NS)

          function SettingsPage() {
            const [snap, setSnap] = useState(() => formController.getSnapshot())
            useEffect(() => {
              const update = () => setSnap(formController.getSnapshot())
              update()
              return formController.subscribe(update)
            }, [])
            const st = snap || { status: 'loading' }
            const status = st.status === 'ready' || st.status === 'unavailable' ? st.status : 'loading'
            // ConfigPage 认的 form 形状和「插件」页给的一样：{ state, mutate }。
            // 直接接共享表单的 snapshot 与写队列，两个入口的保存语义完全一致。
            // useMemo：snapshot 没变时保持 form 引用稳定，ConfigPage 的 [form] effect 不会每轮重跑。
            const pageForm = useMemo(() => ({
              state: { status, value: st.value, revision: st.revision, writable: st.writable },
              mutate: (ops, revision) => formController.mutate(ops, revision),
            }), [status, st.value, st.revision, st.writable])
            return h(ConfigPage, { view: 'page', form: pageForm })
          }

          scope.effect(() => forms.whileServed([CONFIG_NS], () => scope.slots.inject('settings.section', () => scope.slots.register({
            name: 'settings.section',
            id: 'ebbing-context',
            order: 46, // 两个第三方页都是 45（通知提醒 dsh-notify-me / 归档会话 archive-manager，后者被它自己的开关挡着才不显示）；46 排在它们之后、MCP 连接器（80）之前
            label: () => pageTitle(),
          }, SettingsPage))), 'ebbing-context: settings page')
        })
      },
    }
  },
})
