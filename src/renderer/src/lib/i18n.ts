import { useSettings } from '../state/settings'

// ---------------------------------------------------------------------------
// Lightweight UI internationalization. English IS the key, so any untranslated
// string falls back to readable English automatically — translate incrementally.
// Components call `const t = useT()` (re-renders on language change); non-React
// code can use `t(key)` which reads the current language from settings.
// ---------------------------------------------------------------------------

export type Lang = 'en' | 'es' | 'fr' | 'de'

export const LANGUAGES: { value: Lang; label: string }[] = [
  { value: 'en', label: 'English' },
  { value: 'es', label: 'Español' },
  { value: 'fr', label: 'Français' },
  { value: 'de', label: 'Deutsch' }
]

// Per-language overrides keyed by the English string. Missing keys fall back to
// the English key, so partial coverage still renders cleanly.
const STRINGS: Record<Exclude<Lang, 'en'>, Record<string, string>> = {
  es: {
    // top bar
    New: 'Nuevo',
    Open: 'Abrir',
    Save: 'Guardar',
    Options: 'Opciones',
    // transport
    Play: 'Reproducir',
    Pause: 'Pausa',
    Split: 'Dividir',
    Undo: 'Deshacer',
    Redo: 'Rehacer',
    Export: 'Exportar',
    // inspector chrome
    Inspector: 'Inspector',
    'Select a clip or a track to edit it.': 'Selecciona un clip o una pista para editarlo.',
    Transform: 'Transformar',
    Color: 'Color',
    Speed: 'Velocidad',
    Mixer: 'Mezclador',
    EQ: 'Ecualizador',
    Compressor: 'Compresor',
    'Noise Gate': 'Puerta de ruido',
    Ducking: 'Atenuación',
    Audio: 'Audio',
    Text: 'Texto',
    Compositing: 'Composición',
    'Chroma Key': 'Croma',
    Reset: 'Restablecer',
    Normalize: 'Normalizar',
    // options modal
    Performance: 'Rendimiento',
    Editing: 'Edición',
    Appearance: 'Apariencia',
    Theme: 'Tema',
    Density: 'Densidad',
    Language: 'Idioma',
    'Reduce motion': 'Reducir movimiento',
    'Done': 'Hecho',
    'Reset to defaults': 'Restablecer valores'
  },
  fr: {
    New: 'Nouveau',
    Open: 'Ouvrir',
    Save: 'Enregistrer',
    Options: 'Options',
    Play: 'Lire',
    Pause: 'Pause',
    Split: 'Diviser',
    Undo: 'Annuler',
    Redo: 'Rétablir',
    Export: 'Exporter',
    Inspector: 'Inspecteur',
    'Select a clip or a track to edit it.': 'Sélectionnez un clip ou une piste à modifier.',
    Transform: 'Transformer',
    Color: 'Couleur',
    Speed: 'Vitesse',
    Mixer: 'Mixage',
    EQ: 'Égaliseur',
    Compressor: 'Compresseur',
    'Noise Gate': 'Porte de bruit',
    Ducking: 'Atténuation',
    Audio: 'Audio',
    Text: 'Texte',
    Compositing: 'Composition',
    'Chroma Key': 'Incrustation',
    Reset: 'Réinitialiser',
    Normalize: 'Normaliser',
    Performance: 'Performance',
    Editing: 'Édition',
    Appearance: 'Apparence',
    Theme: 'Thème',
    Density: 'Densité',
    Language: 'Langue',
    'Reduce motion': 'Réduire les animations',
    Done: 'Terminé',
    'Reset to defaults': 'Valeurs par défaut'
  },
  de: {
    New: 'Neu',
    Open: 'Öffnen',
    Save: 'Speichern',
    Options: 'Optionen',
    Play: 'Wiedergabe',
    Pause: 'Pause',
    Split: 'Teilen',
    Undo: 'Rückgängig',
    Redo: 'Wiederholen',
    Export: 'Exportieren',
    Inspector: 'Inspektor',
    'Select a clip or a track to edit it.': 'Wähle einen Clip oder eine Spur zum Bearbeiten.',
    Transform: 'Transformieren',
    Color: 'Farbe',
    Speed: 'Geschwindigkeit',
    Mixer: 'Mischer',
    EQ: 'Equalizer',
    Compressor: 'Kompressor',
    'Noise Gate': 'Noise Gate',
    Ducking: 'Ducking',
    Audio: 'Audio',
    Text: 'Text',
    Compositing: 'Compositing',
    'Chroma Key': 'Chroma Key',
    Reset: 'Zurücksetzen',
    Normalize: 'Normalisieren',
    Performance: 'Leistung',
    Editing: 'Bearbeitung',
    Appearance: 'Darstellung',
    Theme: 'Thema',
    Density: 'Dichte',
    Language: 'Sprache',
    'Reduce motion': 'Bewegung reduzieren',
    Done: 'Fertig',
    'Reset to defaults': 'Standard wiederherstellen'
  }
}

/** Translate a key into `lang` (English fallback). */
export function translate(key: string, lang: Lang): string {
  if (lang === 'en') return key
  return STRINGS[lang]?.[key] ?? key
}

/** Non-React translate using the current language from settings. */
export function t(key: string): string {
  return translate(key, useSettings.getState().language)
}

/** React hook: a translator bound to the current language (re-renders on change). */
export function useT(): (key: string) => string {
  const lang = useSettings((s) => s.language)
  return (key: string) => translate(key, lang)
}
