/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        bg: 'rgb(var(--bg) / <alpha-value>)', panel: 'rgb(var(--panel) / <alpha-value>)',
        line: 'rgb(var(--line) / <alpha-value>)', ink: 'rgb(var(--ink) / <alpha-value>)',
        mute: 'rgb(var(--mute) / <alpha-value>)', accent: 'rgb(var(--accent) / <alpha-value>)',
        up: 'rgb(var(--up) / <alpha-value>)', down: 'rgb(var(--down) / <alpha-value>)',
        warn: 'rgb(var(--warn) / <alpha-value>)',
      },
      fontFamily: { mono: ['ui-monospace', 'SFMono-Regular', 'Consolas', 'monospace'] },
    },
  },
  plugins: [],
};
