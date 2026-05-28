export class TryOnEventEmitter {
  constructor() {
    this.listeners = new Map()
  }

  on(eventName, callback) {
    if (!this.listeners.has(eventName)) {
      this.listeners.set(eventName, new Set())
    }

    this.listeners.get(eventName).add(callback)

    return () => this.off(eventName, callback)
  }

  off(eventName, callback) {
    this.listeners.get(eventName)?.delete(callback)
  }

  emit(eventName, detail = {}) {
    const callbacks = this.listeners.get(eventName)
    if (!callbacks?.size) {
      return
    }

    for (const callback of callbacks) {
      callback(detail)
    }
  }
}
