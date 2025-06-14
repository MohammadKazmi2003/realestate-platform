import type { Config } from 'tailwindcss'

const config: Config = {
  content: [
    './src/pages/**/*.{js,ts,jsx,tsx,mdx}',
    './src/components/**/*.{js,ts,jsx,tsx,mdx}',
    './src/app/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {
      colors: {
        'bg-color': 'var(--bg-color)',
        'shadow-light': 'var(--shadow-light)',
        'shadow-dark': 'var(--shadow-dark)',
        'text-color-dark': 'var(--text-color-dark)',
        'text-color-light': 'var(--text-color-light)',
        'danger-color': 'var(--danger-color)',
        'success-color': 'var(--success-color)',
      },
      boxShadow: {
        'neumorphic-outset': '4px 4px 8px var(--shadow-dark), -4px -4px 8px var(--shadow-light)',
        'neumorphic-inset': 'inset 4px 4px 8px var(--shadow-dark), inset -4px -4px 8px var(--shadow-light)',
      },
      backgroundImage: {
        'cta-gradient': 'var(--cta-gradient)',
      },
      fontFamily: {
        sans: ['Inter', 'sans-serif'],
      },
    },
  },
  plugins: [],
}
export default config
