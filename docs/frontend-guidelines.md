# Frontend Guidelines

**Purpose:** Defines styling and design rules for the frontend codebase to ensure consistency and maintainability.

**Contents:**

## 1. UI Library Usage

- **Primary Framework:** [Tailwind CSS](https://tailwindcss.com/) (v3.3.5) is the core library used for styling.
  Leverage utility classes for most styling tasks.
- **Component Libraries:** No major third-party component libraries (like Material-UI or Chakra UI) are in use.
  Components are built using standard HTML elements styled with Tailwind CSS.
- **Helper Utilities:**
  - **Class composition:** No `clsx` / `tailwind-merge` / `cn` helper is in use. Compose static, dynamic, and
    conditional classes with template literals (see §2 below).
  - **`@tailwindcss/typography`:** This plugin is available for styling markdown-generated content or blocks of prose.

## 2. CSS Conventions

- **Utility-First:** Prioritize using Tailwind utility classes directly in the JSX of components.
- **Conditional/Merged Classes:** Compose classes with template literals and inline conditionals. The codebase does
  not use a `cn`/`clsx` helper — keep it dependency-light.

  ```typescript
  // Example usage within a component
  function MyComponent({ isActive, className }: { isActive: boolean; className?: string }) {
    return (
      <div
        className={`base-style p-4 rounded ${
          isActive ? "bg-blue-500 text-white" : "bg-gray-200"
        } ${className ?? ""}`}
      >
        {/* ... */}
      </div>
    );
  }
  ```

- **CSS Modules:** For complex, reusable styling patterns, or styles difficult to express cleanly with utilities, use
  CSS Modules (`*.module.css`).
  - Place module files alongside their corresponding components or in a shared `styles` directory if applicable.
  - Use `camelCase` for class names within CSS Modules (e.g., `.chatContainer`, `.chatInterface`).
- **Global Styles (`styles/globals.css`):**
  - This file imports Tailwind's `base`, `components`, and `utilities`.
  - It contains base HTML element styling (`body`, `h1`, `a`, inputs etc.) and CSS variables (e.g., `--text-color`,
    `--bg-color`) likely used for theming/dark mode.
  - **Avoid adding component-specific styles here.** Keep global styles minimal and focused on application-wide
    defaults.
- **No `styles/base.css`:** This file appears to be unused or empty.

## 3. Component Structure

- **Functional Components:** Write components as React functional components.
- **Hooks:** Use standard React hooks (`useState`, `useEffect`, `useContext`, etc.) for state management and side
  effects within components. Custom hooks are located in the `hooks/` directory (e.g., `useChat`,
  `useMultipleCollections`).
- **Props:** Components should receive data and configuration via props. Use TypeScript (for `.ts`/`.tsx` files) to
  define prop types for better type safety and documentation.
- **File Organization:** Place reusable UI components within the `components/` directory. (Further sub-organization
  within this directory might exist but wasn't detailed in the analyzed files). Pages/Views using Next.js App Router
  reside in the `app/` directory.
- **Styling Application:** Apply styles primarily using the `className` prop with Tailwind utilities, composing
  conditional classes via template literals. Import styles from CSS Modules where necessary.

## 4. Accessibility Standards

- **Semantic HTML:** Use HTML elements according to their semantic meaning (e.g., `<button>` for buttons, `<nav>` for
  navigation, `<label>` for form field labels).
- **Labels:** Always associate `<label>` elements with their corresponding form controls (`<input>`, `<select>`,
  `<textarea>`) using the `htmlFor` attribute linked to the control's `id`.
- **ARIA Attributes:** Apply ARIA attributes (`aria-*`) where necessary to enhance accessibility for dynamic content
  or custom controls, especially when semantic HTML doesn't fully convey the role, state, or properties.
- **Keyboard Navigation & Focus:** Ensure all interactive elements are navigable and operable using a keyboard. Maintain
  logical focus order and visible focus indicators (Tailwind's default focus rings are a good starting point).
- **Linting:** Although `eslint-plugin-jsx-a11y` was not explicitly found in the root `package.json`, adhere to WCAG
  (Web Content Accessibility Guidelines) principles as a best practice. Consider adding and configuring accessibility
  linting rules to enforce standards automatically.

## 5. Conversation History UI Patterns

### Sidebar Design

- **Desktop Layout:** Left sidebar with fixed width (typically `w-64` or `w-80`) containing conversation history
- **Mobile Layout:** Collapsible hamburger menu that slides in from left using responsive design patterns
- **Background:** Use subtle background colors like `bg-gray-100` or `bg-gray-50` to distinguish from main content
- **Responsive Breakpoints:** Use Tailwind's responsive prefixes (`md:`, `lg:`) to show/hide sidebar appropriately

### Conversation List Items

- **Title Display:** AI-generated titles should be prominently displayed with truncation for long titles
- **Fallback Titles:** When AI titles aren't available, show first 4 words of question + "..." for longer questions
- **Active State:** Highlight current conversation with darker background (`bg-white bg-opacity-80 shadow-sm`) and blue
  text (`text-blue-700`)
- **Hover Effects:** Subtle hover states to indicate interactivity
- **Timestamp:** Display relative timestamps ("2 hours ago") or absolute dates for older conversations

### Loading States

- **Async Loading:** Conversation history loads after main chat interface to prioritize core functionality
- **Loading Indicators:** Use skeleton loaders or subtle loading spinners for conversation list
- **Lazy Loading:** Implement "Load More" pattern for conversations beyond the initial 20

### URL Navigation Patterns

- **Stable URLs:** Maintain `/chat/[convId]` URLs that persist across follow-up messages
- **Share URLs:** Generate `/share/[docId]` URLs for point-in-time conversation sharing
- **Browser History:** Use `window.history.pushState` for URL updates without page reloads
- **Deep Linking:** Support direct navigation to conversation URLs with proper loading states

### Mobile Responsiveness

- **Hamburger Menu:** Use standard three-line hamburger icon for mobile sidebar toggle
- **Touch Targets:** Ensure conversation list items have adequate touch target size (minimum 44px height)
- **Swipe Gestures:** Consider implementing swipe-to-open sidebar on mobile devices
- **Viewport Optimization:** Ensure conversation history doesn't interfere with chat input on small screens

### Privacy Mode Indicators

- **Session Type Selection:** Provide clear UI controls for choosing between Public and Temporary modes
- **Visual Indicators:** Use distinct colors or icons to indicate conversation privacy level
- **Future Private Mode:** Prepare UI patterns for upcoming Private conversation option (saved but not shared)

### Share Functionality

- **Share Buttons:** Include share icons on individual messages for generating share links
- **Copy to Clipboard:** Implement one-click copy functionality with user feedback (toast notifications)
- **View-Only Mode:** Clearly indicate when users are viewing shared conversations (disable input, show banner)
- **Social Sharing:** Optimize share URLs for social media previews and accessibility

### Tips & Tricks System

The tips system provides interactive guidance to help users understand key features through animated demonstrations.

#### Creating Animated GIFs for Tips

- **Recording Software:** Use [LICEcap](https://www.cockos.com/licecap/) to create animated GIF demonstrations
- **Recommended Dimensions:** Aim for consistent sizing around 400-550px width for optimal display
- **File Naming:** Use descriptive names like `tips-[feature].gif` (e.g., `tips-sources.gif`, `tips-stars.gif`)
- **Content Guidelines:** Focus on clear, step-by-step demonstrations of specific features
- **Visual Separation:** GIFs are automatically styled with card containers and "Demo" badges for clarity

#### Configuration

- **Location:** Store GIFs in `/data/[siteId]/` directory alongside tips content
- **Config File:** Map GIFs to tips using `/data/[siteId]/tips-config.json`
- **Multi-site Support:** Each site can have its own set of animated demonstrations
- **Responsive Design:** GIFs automatically scale and maintain aspect ratios across devices

```json
{
  "version": 1,
  "gifs": {
    "Tip Title": {
      "url": "/data/ananda/tips-example.gif",
      "width": 444,
      "height": 436,
      "alt": "Descriptive alt text for accessibility",
      "position": "above"
    }
  }
}
```
