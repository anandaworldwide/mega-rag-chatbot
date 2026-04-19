// Generic CSS modules declaration
declare module '*.module.css' {
  const classes: { [key: string]: string };
  export default classes;
}

// Specific module declarations for our CSS files
declare module '@/styles/Home.module.css' {
  const classes: { [key: string]: string };
  export default classes;
}

declare module '@/styles/MarkdownStyles.module.css' {
  const classes: { [key: string]: string };
  export default classes;
}

declare module '*.css' {
  const styles: { [key: string]: string };
  export default styles;
}
