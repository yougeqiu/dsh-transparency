/** 每 session 门控：off(默认)/once/sticky；gateFor 返回当前待放行的 gate 或 null。 */
export class HoldRegistry {
  #armed = new Map()  // sessionId -> 'once' | 'sticky'
  #pending = new Map() // sessionId -> PromiseWithResolvers

  arm(sessionId, once = false) { this.#armed.set(String(sessionId), once ? 'once' : 'sticky') }
  disarm(sessionId) { this.#armed.delete(String(sessionId)); this.release(sessionId) }
  state(sessionId) { return this.#armed.get(String(sessionId)) ?? 'off' }

  gateFor(sessionId) {
    const key = String(sessionId)
    if (!this.#armed.has(key)) return null
    if (this.#armed.get(key) === 'once') this.#armed.delete(key)
    if (this.#pending.has(key)) return this.#pending.get(key)
    const gate = Promise.withResolvers()
    this.#pending.set(key, gate)
    return gate
  }

  release(sessionId) { this.#pending.get(String(sessionId))?.resolve(); this.#pending.delete(String(sessionId)) }
  pending(sessionId) { return this.#pending.has(String(sessionId)) }
}
