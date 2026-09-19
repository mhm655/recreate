import CodeMirror from '@uiw/react-codemirror';
import { javascript } from '@codemirror/lang-javascript';
import { createTheme } from '@uiw/codemirror-themes';
import { EditorView } from '@codemirror/view';
import { tags as t } from '@lezer/highlight';
import type { Theme } from '../theme';

const jsLang = javascript({ typescript: true, jsx: false });

const fixedHeightEditor = EditorView.theme({
  '&': { fontFamily: 'var(--font-mono)' },
});

/** Restrained, mostly-desaturated syntax palette -- a few muted structural hues,
 * no branded accent color. Caret/selection use the paper tone, not a hue. */
const darkTheme = createTheme({
  theme: 'dark',
  settings: {
    background: 'transparent',
    foreground: '#dcdad2',
    caret: '#eeece5',
    selection: 'rgba(238, 236, 229, 0.16)',
    selectionMatch: 'rgba(238, 236, 229, 0.12)',
    lineHighlight: 'rgba(255, 255, 255, 0.03)',
    gutterBackground: 'transparent',
    gutterForeground: '#4c4d50',
    gutterActiveForeground: '#8b8c8f',
    fontFamily: 'var(--font-mono)',
  },
  styles: [
    { tag: [t.keyword, t.controlKeyword, t.moduleKeyword], color: '#7e93a8' },
    { tag: [t.string, t.special(t.string)], color: '#b3a476' },
    { tag: [t.number, t.bool, t.null], color: '#d99a3d' },
    { tag: [t.function(t.variableName), t.function(t.propertyName)], color: '#c9c6bb' },
    { tag: [t.typeName, t.className, t.definition(t.typeName)], color: '#a48f9c' },
    { tag: t.comment, color: '#5c5d59', fontStyle: 'italic' },
    { tag: [t.punctuation, t.bracket], color: '#75767a' },
    { tag: t.propertyName, color: '#9a9b9d' },
    { tag: t.operator, color: '#8b8c8f' },
  ],
});

const lightTheme = createTheme({
  theme: 'light',
  settings: {
    background: 'transparent',
    foreground: '#2c2b26',
    caret: '#1a1912',
    selection: 'rgba(26, 25, 18, 0.1)',
    selectionMatch: 'rgba(26, 25, 18, 0.07)',
    lineHighlight: 'rgba(26, 25, 18, 0.035)',
    gutterBackground: 'transparent',
    gutterForeground: '#a7a598',
    gutterActiveForeground: '#5c5b52',
    fontFamily: 'var(--font-mono)',
  },
  styles: [
    { tag: [t.keyword, t.controlKeyword, t.moduleKeyword], color: '#3c5878' },
    { tag: [t.string, t.special(t.string)], color: '#7a6a2f' },
    { tag: [t.number, t.bool, t.null], color: '#a3710e' },
    { tag: [t.function(t.variableName), t.function(t.propertyName)], color: '#33322b' },
    { tag: [t.typeName, t.className, t.definition(t.typeName)], color: '#78516a' },
    { tag: t.comment, color: '#93917f', fontStyle: 'italic' },
    { tag: [t.punctuation, t.bracket], color: '#6b6a5f' },
    { tag: t.propertyName, color: '#54534a' },
    { tag: t.operator, color: '#6b6a5f' },
  ],
});

interface CodeEditorProps {
  value: string;
  onChange?: (value: string) => void;
  readOnly?: boolean;
  theme: Theme;
  minHeight?: string;
  maxHeight?: string;
  placeholder?: string;
  ariaLabel?: string;
}

export default function CodeEditor({
  value,
  onChange,
  readOnly = false,
  theme,
  minHeight = '200px',
  maxHeight = '420px',
  placeholder,
  ariaLabel,
}: CodeEditorProps) {
  return (
    <div className="code-editor" data-readonly={readOnly || undefined}>
      <CodeMirror
        value={value}
        onChange={onChange}
        readOnly={readOnly}
        editable={!readOnly}
        theme={theme === 'dark' ? darkTheme : lightTheme}
        extensions={[jsLang, fixedHeightEditor]}
        basicSetup={{
          lineNumbers: true,
          foldGutter: false,
          highlightActiveLine: !readOnly,
          highlightActiveLineGutter: !readOnly,
          autocompletion: false,
        }}
        minHeight={minHeight}
        maxHeight={maxHeight}
        placeholder={placeholder}
        aria-label={ariaLabel}
      />
    </div>
  );
}
