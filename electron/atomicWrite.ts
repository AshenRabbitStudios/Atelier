import { writeFileSync, renameSync, rmSync, mkdirSync } from 'node:fs'
import { dirname, join, basename } from 'node:path'

// Atomic file write shared by every JSON persistence path (plugin storage, conversation
// manifests, app state). A plain writeFileSync truncates the target before writing, so a
// crash/power-cut mid-write silently corrupts it — and our loaders treat a parse failure as
// "empty", which for the highest-value state (context documents: mental models, maps, plans)
// is silent total loss (ARCH_REVIEW_2026-07-19 P0 #5).
//
// The fix: write a sibling temp file, then rename it over the target. Rename is atomic on the
// same volume (POSIX rename(2); Windows MoveFileEx with replace-existing via Node's renameSync),
// so a reader ever sees either the whole old file or the whole new one — never a torn write.

/** Write `data` to `file` atomically (temp-write + rename). Creates parent dirs. Throws on failure
 *  after cleaning up the temp file, so the target is never left half-written. */
export function writeFileAtomic(file: string, data: string): void {
  const dir = dirname(file)
  mkdirSync(dir, { recursive: true })
  // Temp sibling in the SAME directory so the rename stays on one volume (cross-device rename is
  // not atomic and would EXDEV). Hidden + pid/time-tagged so concurrent writers don't collide.
  const tmp = join(dir, `.${basename(file)}.${process.pid}.${Date.now()}.tmp`)
  try {
    writeFileSync(tmp, data, 'utf8')
    renameSync(tmp, file)
  } catch (err) {
    try {
      rmSync(tmp, { force: true })
    } catch {
      /* temp already gone / never created */
    }
    throw err
  }
}
