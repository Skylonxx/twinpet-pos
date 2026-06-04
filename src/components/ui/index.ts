/**
 * TwinPet UI primitive kit — the single import surface for shared UI built on
 * flowbite-react + Tailwind v4. Feature code imports from here (not directly
 * from 'flowbite-react') so we can swap/extend wrappers in one place.
 *
 * Theme is applied app-wide via <ThemeProvider theme={twinpetTheme}> (App.tsx).
 */
export { twinpetTheme } from './theme';

export {
  // Actions
  Button,
  // Surfaces
  Card,
  // Status
  Badge,
  Alert,
  Spinner,
  Tooltip,
  // Form controls
  Label,
  TextInput,
  Textarea,
  Select,
  Checkbox,
  Radio,
  ToggleSwitch,
  // Overlays / menus
  Dropdown,
  DropdownHeader,
  DropdownItem,
  DropdownDivider,
  // Sidebar / navigation
  Sidebar,
  SidebarItems,
  SidebarItemGroup,
  SidebarItem,
  SidebarCollapse,
  // Table
  Table,
  TableHead,
  TableHeadCell,
  TableBody,
  TableRow,
  TableCell,
} from 'flowbite-react';
