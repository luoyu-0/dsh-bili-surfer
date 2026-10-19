/**
 * src/lib/tools.ts —— 工具定义的最小实现（**不 import 任何 `@deepseek-ai/*`**）
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

/** JSON Schema 的宽松形状：本模块只关心其中几个关键字，其余原样透传。 */
export interface JsonSchema {
  type?: string | readonly string[]
  description?: string
  properties?: Record<string, JsonSchema>
  required?: readonly string[]
  additionalProperties?: boolean | JsonSchema
  items?: JsonSchema
  oneOf?: readonly JsonSchema[]
  enum?: readonly unknown[]
  default?: unknown
  [k: string]: unknown
}

/**
 * 逐属性参数表里的**一个属性**。
 * 注意 `required: true` 与嵌套 schema 里的 `required: string[]` 同名但含义不同：
 * 这一层的 `required` 是给编译器的注解（编译时摘掉），数组是 JSON Schema 的必需字段表。
 */
export interface ParamNode {
  type?: string | readonly string[]
  description?: string
  /** 写在属性上的注解：真值表示这个属性进根的 `required[]`；编译时会被摘掉。 */
  required?: boolean | readonly string[]
  additionalProperties?: boolean | ParamNode
  properties?: Record<string, ParamNode>
  items?: ParamNode
  oneOf?: readonly ParamNode[]
  enum?: readonly unknown[]
  default?: unknown
  [k: string]: unknown
}

/** `defineTool` 的 parameters：形如 `{ keyword: { type:'string', required:true, description } }`。 */
export type ParamSpec = Record<string, ParamNode>

/** 模型看到的一段输出内容（本模块只产出文本，但类型上不锁死）。 */
export interface ToolContentBlock {
  type: string
  text?: string
  [k: string]: unknown
}

/** 工具的输出形状：schema 用来声明（无损 JSON），render 只负责排版。 */
export interface ToolOutput<T = unknown> {
  schema: JsonSchema
  render: (args: unknown, value: T) => readonly ToolContentBlock[]
}

/** 模型看到的输出形状：文本。schema 是"无损 JSON"，`render` 只负责排版。 */
export const textOutput: ToolOutput<unknown> = {
  schema: { type: 'object', properties: {}, additionalProperties: true },
  render: (_args, value) => [{
    type: 'text',
    text: typeof value === 'string' ? value : JSON.stringify(value, null, 2),
  }],
}

/** 工具处理函数收到的是任意 JSON 参数（已由宿主按 schema 收窄过一次，但仍按 unknown 对待）。 */
export type ToolExecute<T = unknown> = (args: Record<string, unknown>, exec: unknown) => T | Promise<T>

/** 定义工具时传进来的选项（与宿主 `defineTool` 形状兼容，允许带额外字段）。 */
export interface ToolOptions<T = unknown> {
  name: string
  description?: string
  parameters?: ParamSpec
  output?: ToolOutput<T>
  execute?: ToolExecute<T>
  [k: string]: unknown
}

/** `defineTool` 的返回值：parameters 已编译成 JSON Schema，output 一定有值。 */
export interface ToolDefinition<T = unknown> {
  name: string
  description?: string
  parameters: JsonSchema
  output: ToolOutput<T>
  execute?: ToolExecute<T>
  [k: string]: unknown
}

/** `ctx.tools` 里我们真正用到的那一小块。 */
export interface ToolRegistry {
  register(definition: ToolDefinition): unknown
}

/** `makeToolRegistrar` 返回的注册函数，额外带一个 `names()` 查已注册的名字。 */
export interface ToolRegistrar {
  (spec: ToolSpec): unknown
  names(): string[]
}

/** 注册一个工具时的必填形状：execute 是必须的（defineTool 会校验）。 */
export interface ToolSpec<T = unknown> extends ToolOptions<T> {
  execute: ToolExecute<T>
}

const VALUE_TYPES = new Set(['string', 'number', 'integer', 'boolean', 'null', 'array', 'object', 'json'])

/**
 * 逐属性参数表 → 标准 JSON Schema（对象根）。
 * @param spec 形如 `{ keyword: { type:'string', required:true, description } }`
 */
export function compileParams(spec: ParamSpec = {}): JsonSchema {
  const properties: Record<string, JsonSchema> = {}
  const required: string[] = []
  for (const [key, raw] of Object.entries(spec ?? {})) {
    const node: Record<string, unknown> = { ...(raw || {}) }
    if (node.required) required.push(key)
    delete node.required
    assertObjectNodes(node, `parameters.${key}`)
    properties[key] = node as JsonSchema
  }
  return {
    type: 'object',
    properties,
    ...(required.length ? { required } : {}),
  }
}

/** 宿主规则：自己写的每个 object 节点都要显式 additionalProperties（隐式参数根除外）。 */
export function assertObjectNodes(node: unknown, where = 'schema'): void {
  if (!node || typeof node !== 'object') return
  const n = node as JsonSchema
  const t = n.type
  // 数组形式的 type（JSON Schema 允许）同样不认识 —— 与原实现一致：一律当错误。
  if (t && !(typeof t === 'string' && VALUE_TYPES.has(t))) {
    throw new Error(`defineTool: ${where}.type 不认识：${t}`)
  }
  if (n.type === 'json') return // 注解节点，没有子结构
  if (n.type === 'object' && n.additionalProperties === undefined) {
    throw new Error(`defineTool: ${where} 是 object 却没写 additionalProperties（宿主会直接报错）`)
  }
  for (const [k, v] of Object.entries(n.properties || {})) assertObjectNodes(v, `${where}.properties.${k}`)
  if (n.items) assertObjectNodes(n.items, `${where}.items`)
  for (const branch of n.oneOf || []) assertObjectNodes(branch, `${where}.oneOf[]`)
}

/**
 * 与宿主 `defineTool` 形状兼容的本地实现。
 * @param options 宿主那份的选项：name / description / parameters / output / execute
 */
export function defineTool<T = unknown>(options: ToolOptions<T>): ToolDefinition<T> {
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
export function safe(v: unknown): unknown {
  return walk(v, 'result', new WeakSet())
}

function walk(v: unknown, path: string, seen: WeakSet<object>): unknown {
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
      const name = (v as { constructor?: { name?: string } }).constructor?.name || '非普通对象'
      throw new Error(`返回值不是无损 JSON：${path} 是 ${name}（class 实例 / Map / Date / Error 之类进宿主会报 value is not lossless JSON）`)
    }
    if (seen.has(v)) throw new Error(`返回值不是无损 JSON：${path} 有循环引用`)
    seen.add(v)
    const out: Record<string, unknown> = {}
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
 * @param tools `ctx.tools`
 */
export function makeToolRegistrar(tools: ToolRegistry): ToolRegistrar {
  const registered: string[] = []
  const tool = Object.assign(
    (spec: ToolSpec): unknown => {
      const definition = defineTool({
        ...spec,
        output: spec.output || textOutput,
        async execute(args: Record<string, unknown>, exec: unknown): Promise<unknown> {
          try {
            return safe(await spec.execute(args ?? {}, exec))
          } catch (e) {
            return { ok: false, error: String((e as { message?: unknown } | null)?.message || e) }
          }
        },
      })
      registered.push(definition.name)
      try {
        return tools.register(definition)
      } catch (e) {
        throw new Error(`注册工具 ${definition.name} 失败：${(e as { message?: unknown } | null)?.message || e}`)
      }
    },
    { names: (): string[] => registered.slice() },
  )
  return tool
}
