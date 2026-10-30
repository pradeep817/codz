import type { Config } from 'tailwindcss';

const config: Config = {
  content: ['./app/**/*.{ts,tsx}'],
  theme: {
    extend: {
      borderRadius: {
        DEFAULT: '12px',
      },
      colors: {
        primary: '#6750a4',
      },},
  },
  plugins: [],
};
export default config;
