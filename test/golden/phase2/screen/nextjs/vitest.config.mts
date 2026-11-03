import react from '@vitejs/plugin-react';
import tsconfigPaths from 'vite-tsconfig-paths';
import { defineConfig } from 'vitest/config';

// Renders pages in tests: JSX with the React plugin, @/ imports from tsconfig paths (codz screen add).
export default defineConfig({
  plugins: [tsconfigPaths(), react()],
});
