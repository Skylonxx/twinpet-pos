import { createTheme } from 'flowbite-react';

/**
 * Project-wide theme overrides for flowbite-react.
 *
 * Flowbite's default component colors already reference Tailwind's `primary-*`
 * scale, which we bridged to the TwinPet purple in src/index.css (@theme) — so
 * <Button>, <Spinner>, etc. inherit the brand automatically. This adds an
 * explicit `primary` color key (brand --p600) so `<Button color="primary">`
 * reads intentionally and maps to the exact existing primary-button shade.
 */
export const twinpetTheme = createTheme({
  button: {
    color: {
      primary:
        'bg-primary-600 text-white hover:bg-primary-800 focus:ring-4 focus:ring-primary-200',
    },
  },
});
