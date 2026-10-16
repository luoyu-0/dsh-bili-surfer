/**
 * lib/tools.mjs —— 工具定义的最小实现（**不 import 任何 `@deepseek-ai/*`**）
 * ============================================================================
 * 为什么自己写而不是 `import { defineTool } from '@deepseek-ai/dsh-tools'`：
 *   dsh-tools 在本机是 optional peer，桌面 profile 是 `autoInstallPeers: false` ⇒ 不会装
 *   ⇒ **裸 import 会让整条插件不激活**（设置页直接不出现，只有一句
 *   `1 entry did not activate`）。所以本插件零 `@deepseek-ai/*` 依赖。
 *
 * `defineTool` 在宿主里做的两件事，这里照着做（少一件就会踩坑）：
 *   ① 把「逐属性参数表」编译成标准 JSON Schema 的对象根
 *      （`parameterSchemaSpecToJsonSchema`：`{type:'object', properties, required?}`，
 *        `required: true` 是**写在属性上**的注解，编译时要摘出来）；
 *   ② 校验每个自定义的 object 节点都显式写了 `additionalProperties`
 *      （缺了宿主会抛 `additionalProperties must be explicitly true or false`）。
 * 它没做的事：`ctx.tools.register` 只校验 `output`，**不校验 parameters** ——
 *   所以 parameters 传错形状不会有报错，只会让模型看到一份畸形 schema。这里是唯一的防线。
 * ============================================================================
 */

/** 模型看到的输出形状：文本。schema 是"无损 JSON"，`render` 只负责排版。 */
export const textOutput = {
  schema: { type: 'object', properties: {}, additionalProperties: true },
  render: (_args, value) => [{
    type: 'text',
    text: typeof value === 'string' ? value : JSON.stringify(value, null, 2),
  }],
}

const VALUE_TYPES = new Set(['string', 'number', 'integer', 'boolean', 'null', 'array', 'object', 'json'])

/**
 * 逐属性参数表 → 标准 JSON Schema（对象根）。
 * @param {Record<string, object>} spec 形如 `{ keyword: { type:'string', required:true, description } }`
 */
export function compileParams(spec = {}) {
  const properties = {}
  const required = []
  for (const [key, raw] of Object.entries(spec || {})) {
    const node = { ...(raw || {}) }
    if (node.required) required.push(key)
    delete node.required
    assertObjectNodes(node, `parameters.${key}`)
    properties[key] = node
  }
  return {
    type: 'object',
    properties,
    ...(required.length ? { required } : {}),
  }
}

/** 宿主规则：自己写的每个 object 节点都要显式 additionalProperties（隐式参数根除外）。 */
export function assertObjectNodes(node, where = 'schema') {
  if (!node || typeof node !== 'object') return
  if (node.type && !VALUE_TYPES.has(node.type)) {
    throw new Error(`defineTool: ${where}.type 不认识：${node.type}`)
  }
  if (node.type === 'json') return // 注解节点，没有子结构
  if (node.type === 'object' && node.additionalProperties === undefined) {
    throw new Error(`defineTool: ${where} 是 object 却没写 additionalProperties（宿主会直接报错）`)
  }
  for (const [k, v] of Object.entries(node.properties || {})) assertObjectNodes(v, `${where}.properties.${k}`)
  if (node.items) assertObjectNodes(node.items, `${where}.items`)
  for (const branch of node.oneOf || []) assertObjectNodes(branch, `${where}.oneOf[]`)
}

/**
 * 与宿主 `defineTool` 形状兼容的本地实现。
 * @param {{name:string, description:string, parameters?:object, output?:object, execute:Function}} options
 */
export function defineTool(options) {
  if (!options?.name) throw new Error('defineTool: 缺 name')
  if (typeof options.execute !== 'function') throw new Error(`defineTool(${options.name}): 缺 execute`)
  const output = options.output || textOutput
  if (typeof output.render !== 'function') throw new Error(`defineTool(${options.name}): output.render 必须是函数`)
  assertObjectNodes(output.schema, 'output.schema')
  return {
    ...options,
    parameters: compileParams(options.parameters),
    output,
  }
}

/**
 * 返回值必须是无损 JSON —— 函数/类实例/Map/循环引用进宿主会报
 * `value is not lossless JSON`，而且是**运行时**才报（工具已经跑完了）。
 * 所以在这里先逐字段走一遍：不是纯 JSON 的值就地抛出，让 makeToolRegistrar 收敛成 {ok:false}。
 */
export function safe(v) {
  return walk(v, 'result', new WeakSet())
}

function walk(v, path, seen) {
  if (v === null || typeof v === 'string' || typeof v === 'boolean') return v
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new Error(`返回值不是无损 JSON：${path} = ${v}`)
    return v
  }
  if (Array.isArray(v)) {
    if (seen.has(v)) throw new Error(`返回值不是无损 JSON：${path} 有循环引用`)
    seen.add(v)
    return v.map((x, i) => walk(x, `${path}[${i}]`, seen))
  }
  if (typeof v === 'object') {
    const proto = Object.getPrototypeOf(v)
    if (proto !== Object.prototype && proto !== null) {
      const name = v?.constructor?.name || '非普通对象'
      throw new Error(`返回值不是无损 JSON：${path} 是 ${name}（class 实例 / Map / Date / Error 之类进宿主会报 value is not lossless JSON）`)
    }
    if (seen.has(v)) throw new Error(`返回值不是无损 JSON：${path} 有循环引用`)
    seen.add(v)
    const out = {}
    for (const [k, x] of Object.entries(v)) {
      if (x === undefined) continue // JSON.stringify 同款行为：丢掉 undefined 字段
      out[k] = walk(x, `${path}.${k}`, seen)
    }
    return out
  }
  throw new Error(`返回值不是无损 JSON：${path} 是 ${typeof v}`)
}

/**
 * 注册一个工具。任何异常都收敛成 `{ok:false,error}` —— 工具里抛异常会把整次会话搞脏。
 * @param {{register:Function}} tools `ctx.tools`
 */
export function makeToolRegistrar(tools) {
  const registered = []
  const tool = (spec) => {
    const definition = defineTool({
      ...spec,
      output: spec.output || textOutput,
      async execute(args, exec) {
        try {
          return safe(await spec.execute(args ?? {}, exec))
        } catch (e) {
          return { ok: false, error: String(e?.message || e) }
        }
      },
    })
    registered.push(definition.name)
    try {
      return tools.register(definition)
    } catch (e) {
      throw new Error(`注册工具 ${definition.name} 失败：${e?.message || e}`)
    }
  }
  tool.names = () => registered.slice()
  return tool
}
