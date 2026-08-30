/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    './app/**/*.{js,jsx}',
    './components/**/*.{js,jsx}',
  ],
  theme: {
    extend: {
      colors: {
        ink: '#12181B',
        surface: '#FFFFFF',
        ground: '#F4F6F7',
        accent: '#1F6F5C',
        line: '#DCE3E5',
      },
    },
  },
  plugins: [],
};
