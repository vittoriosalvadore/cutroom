import { useEffect, useState } from 'react'
import { useEditor } from '../state/store'
import { useSettings } from '../state/settings'
import { useT } from '../lib/i18n'
import {
  cancelProxy,
  ensureProxy,
  getProxyEntry,
  proxyCacheVersion,
  subscribeProxyCache
} from '../lib/proxyCache'
import type { MediaItem } from '../types'

const ICON: Record<string, string> = { video: '🎬', audio: '♪', image: '🖼' }
// English labels (i18n keys) for the media kind shown under each name.
const KIND_LABEL: Record<string, string> = { video: 'Video', audio: 'Audio', image: 'Image' }

/**
 * Proxy status + action for one video item: Create → queued / NN% (cancel) →
 * a Proxy badge, or a failure badge with retry. Buttons swallow double-clicks
 * so they don't also add the clip to the timeline.
 */
function ProxyControl({ media }: { media: MediaItem }) {
  const t = useT()
  const useProxies = useSettings((s) => s.useProxies)
  const entry = getProxyEntry(media.path)
  const stop = (e: React.MouseEvent): void => e.stopPropagation()

  if (entry?.status === 'ready') {
    return (
      <span
        className={`proxy-badge ${useProxies ? 'ready' : 'off'}`}
        title={
          useProxies
            ? t('Proxy ready — the preview uses it. Export always uses the original.')
            : t('Proxy ready, but proxies are turned off in Options.')
        }
      >
        {t('Proxy')}
      </span>
    )
  }
  if (entry?.status === 'queued' || entry?.status === 'processing') {
    const pct = Math.round(entry.progress * 100)
    return (
      <span className="proxy-progress" onDoubleClick={stop}>
        <span className="proxy-bar">
          <span style={{ width: `${pct}%` }} />
        </span>
        <span className="proxy-pct">{entry.status === 'queued' ? t('Proxy queued') : t('Proxy {pct}%', { pct })}</span>
        <button
          className="proxy-x"
          title={t('Cancel proxy')}
          onClick={(e) => {
            e.stopPropagation()
            cancelProxy(media.path)
          }}
        >
          ✕
        </button>
      </span>
    )
  }
  return (
    <span className="proxy-actions" onDoubleClick={stop}>
      {entry?.status === 'error' && (
        <span className="proxy-badge error" title={entry.error}>
          {t('Proxy failed')}
        </span>
      )}
      <button
        className="btn small proxy-create"
        title={t('Create a lightweight 720p copy for smoother preview. Export always uses the original.')}
        onClick={(e) => {
          e.stopPropagation()
          void ensureProxy(media.path, media.durationSec)
        }}
      >
        {t('Create proxy')}
      </button>
    </span>
  )
}

export default function MediaBin() {
  // Only `media` drives the rendered list. Tracks + playhead are read lazily in
  // the click handler so the bin doesn't re-render ~60x/s during playback (when
  // only the playhead changes).
  const media = useEditor((s) => s.project.media)
  const importMedia = useEditor((s) => s.importMedia)
  const t = useT()
  // Re-render on proxy progress / completion (the cache lives outside React).
  const [, setProxyVersion] = useState(proxyCacheVersion)
  useEffect(() => subscribeProxyCache(() => setProxyVersion(proxyCacheVersion())), [])

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
        <span>{t('Media Bin')}</span>
        <button className="btn small" onClick={onImport}>
          + {t('Import')}
        </button>
      </div>
      <div className="bin-list">
        {items.length === 0 && (
          <div className="empty">
            {t('No media yet.')}
            {'\n'}
            {t('Click Import or drop files here.')}
          </div>
        )}
        {items.map((m) => (
          <div
            key={m.id}
            className="bin-item"
            title={t('Double-click to add at the playhead')}
            onDoubleClick={() => onAdd(m.id, m.kind)}
          >
            <div className={`thumb ${m.kind}`}>{ICON[m.kind] ?? '🎬'}</div>
            <div className="meta">
              <div className="name">{m.name}</div>
              <div className="sub">
                {t(KIND_LABEL[m.kind] ?? m.kind)}
                {m.durationSec ? ` · ${m.durationSec.toFixed(1)}s` : ''}
                {m.width && m.height ? ` · ${m.width}×${m.height}` : ''}
              </div>
              {m.kind === 'video' && m.path && <ProxyControl media={m} />}
            </div>
          </div>
        ))}
      </div>
    </aside>
  )
}
