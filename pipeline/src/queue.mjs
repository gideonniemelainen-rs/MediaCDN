// A serial queue: tasks run one at a time, in the order added. The upload jobs and the workflow runs share one, because
// ffmpeg is heavy and a benchmark measures the network, so neither should overlap the other.
export function createQueue() {
  let tail = Promise.resolve()
  return {
    /** Runs `task` after everything added before it. A task that throws is the task's problem: later ones still run. */
    add(task) {
      tail = tail.then(task).catch(() => {})
    },
    /** Resolves once everything added so far (including what was added while waiting) has finished. */
    async idle() {
      let seen
      do {
        seen = tail
        await seen
      } while (seen !== tail)
    },
  }
}
