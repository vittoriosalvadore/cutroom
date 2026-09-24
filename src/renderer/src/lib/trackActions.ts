import { useEditor } from '../state/store'
import { canRemoveTrack } from './tracks'
import { t } from './i18n'

/**
 * UI entry point for deleting a track (timeline menu + Inspector): asks for
 * confirmation when the track still holds clips, since they go with it (the
 * delete is one undo step either way). Returns whether the track was removed.
 */
export function removeTrackWithConfirm(trackId: string): boolean {
  const st = useEditor.getState()
  const track = st.project.tracks.find((tr) => tr.id === trackId)
  if (!track || !canRemoveTrack(st.project.tracks, trackId)) return false
  const count = Object.values(st.project.clips).filter((c) => c.trackId === trackId).length
  if (count > 0) {
    const msg = t('Delete track "{name}" and its {n} clip(s)?')
      .replace('{name}', track.name)
      .replace('{n}', String(count))
    if (!window.confirm(msg)) return false
  }
  st.removeTrack(trackId)
  return true
}
