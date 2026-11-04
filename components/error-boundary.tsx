'use client';

import React, { Component, ErrorInfo, ReactNode } from 'react';
import { AlertTriangle, RefreshCw } from 'lucide-react';

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
  errorInfo: ErrorInfo | null;
}

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = {
      hasError: false,
      error: null,
      errorInfo: null,
    };
  }

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    this.setState({ errorInfo });
    if (process.env.NODE_ENV === 'development') {
      console.error('ErrorBoundary caught an error:', error, errorInfo);
    }
  }

  handleReload = (): void => {
    this.setState({ hasError: false, error: null, errorInfo: null });
    window.location.reload();
  };

  render(): ReactNode {
    if (this.state.hasError) {
      if (this.props.fallback) {
        return this.props.fallback;
      }

      return (
        <div className="min-h-screen flex items-center justify-center bg-[var(--bg-primary)]">
          <div className="max-w-md w-full mx-4">
            <div className="bg-[var(--bg-secondary)] border border-[var(--border)] rounded-xl p-8 text-center">
              <div className="w-16 h-16 mx-auto mb-6 rounded-full bg-red-500/20 flex items-center justify-center">
                <AlertTriangle className="w-8 h-8 text-red-400" />
              </div>
              <h1 className="text-xl font-bold mb-2">Something went wrong</h1>
              <p className="text-[var(--text-secondary)] mb-6">
                We encountered an unexpected error. Please try reloading the page.
              </p>
              {process.env.NODE_ENV === 'development' && this.state.error && (
                <details className="text-left mb-6 p-3 bg-[var(--bg-primary)] rounded-lg text-sm">
                  <summary className="font-semibold cursor-pointer mb-2">Error Details</summary>
                  <pre className="overflow-auto text-red-400 whitespace-pre-wrap">
                    {String(this.state.error.message)}
                    {this.state.errorInfo?.componentStack && (
                      <>{'\n\n'}{String(this.state.errorInfo.componentStack)}</>
                    )}
                  </pre>
                </details>
              )}
              <button
                onClick={this.handleReload}
                className="inline-flex items-center gap-2 px-6 py-3 bg-purple-500 hover:bg-purple-600 text-white font-medium rounded-lg transition-colors"
              >
                <RefreshCw className="w-4 h-4" />
                Reload Page
              </button>
            </div>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}

