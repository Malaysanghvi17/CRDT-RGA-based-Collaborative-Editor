export type Theme = 'light' | 'dark';

export class AppTheme {
  private readonly STORAGE_KEY = 'theme';

  private getStoredTheme(): Theme | null {
    const value = localStorage.getItem(this.STORAGE_KEY);

    return value === 'light' || value === 'dark' ? value : null;
  }

  private getSystemTheme(): Theme {
    return window.matchMedia('(prefers-color-scheme: light)').matches
      ? 'light'
      : 'dark';
  }

  private applyTheme(theme: Theme): void {
    document.documentElement.setAttribute('data-theme', theme);
  }

  public initTheme(): void {
    // Apply saved theme, otherwise use system theme
    this.applyTheme(
      this.getStoredTheme() ?? this.getSystemTheme()
    );

    const toggleBtn = document.getElementById('theme-toggle');

    toggleBtn?.addEventListener('click', () => {
      const current =
        document.documentElement.getAttribute('data-theme') as Theme;

      const next: Theme =
        current === 'light' ? 'dark' : 'light';

      this.applyTheme(next);
      localStorage.setItem(this.STORAGE_KEY, next);
    });

    window
      .matchMedia('(prefers-color-scheme: light)')
      .addEventListener('change', (event) => {
        if (!this.getStoredTheme()) {
          this.applyTheme(event.matches ? 'light' : 'dark');
        }
      });
  }
}