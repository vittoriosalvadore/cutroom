import { useEditor } from '../state/store'

const ICON: Record<string, string> = { video: '🎬', audio: '♪', image: '🖼' }

export default function MediaBin() {
  // Only `media` drives the rendered list. Tracks + playhead are read lazily in
  // the click handler so the bin doesn't re-render ~60x/s during playback (when
  // only the playhead changes).
  const media = useEditor((s) => s.project.media)
  const importMedia = useEditor((s) => s.importMedia)

  const onImport = async (): Promise<void> => {
    const paths = await window.cutroom.openMedia()
    if (paths.length) importMedia(paths)
  }

  const onAdd = (mediaId: string, kind: string): void => {
    // Audio media -> first audio lane; everything else -> first video lane.
    const st = useEditor.getState()
    const wantKind = kind === 'audio' ? 'audio' : 'video'
    const track = st.project.tracks.find((t) => t.kind === wantKind)
    if (track) st.addClipFromMedia(mediaId, track.id, st.playheadSec)
  }

  const items = Object.values(media)

  return (
    <aside className="bin">
      <div className="panel-head">
        <span>Media Bin</span>
        <button className="btn small" onClick={onImport}>
          + Import
        </button>
      </div>
      <div className="bin-list">
        {items.length === 0 && (
          <div className="empty">No media yet.{'\n'}Click Import or drop files here.</div>
        )}
        {items.map((m) => (
          <div
            key={m.id}
            className="bin-item"
            title="Double-click to add at the playhead"
            onDoubleClick={() => onAdd(m.id, m.kind)}
          >
            <div className={`thumb ${m.kind}`}>{ICON[m.kind] ?? '🎬'}</div>
            <div className="meta">
              <div className="name">{m.name}</div>
              <div className="sub">
                {m.kind}
                {m.durationSec ? ` · ${m.durationSec.toFixed(1)}s` : ''}
              </div>
            </div>
          </div>
        ))}
      </div>
    </aside>
  )
}
