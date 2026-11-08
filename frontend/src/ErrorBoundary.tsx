import * as React from "react";
import type { ReactNode, ErrorInfo } from "react";

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
  errorInfo: string | null;
}

export class ErrorBoundary extends React.Component<Props, State> {
  state: State = { hasError: false, error: null, errorInfo: null };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    console.error("[ErrorBoundary] Caught a render error:", error, errorInfo);
    this.setState({ errorInfo: errorInfo.componentStack || null });
  }

  handleReset = (): void => {
    this.setState({ hasError: false, error: null, errorInfo: null });
  };

  handleReload = (): void => {
    window.location.reload();
  };

  render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen bg-stone-50 flex items-center justify-center p-4 font-sans">
          <div className="bg-white rounded-2xl shadow-xl max-w-lg w-full p-8 border border-stone-200">
            <div className="w-14 h-14 bg-rose-50 rounded-full flex items-center justify-center mx-auto mb-5 text-rose-500">
              <svg className="w-8 h-8" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01M4.93 19h14.14c1.54 0 2.5-1.67 1.73-3L13.73 4a2 2 0 00-3.46 0L3.2 16c-.77 1.33.19 3 1.73 3z" />
              </svg>
            </div>
            <h1 className="text-xl font-bold text-stone-900 text-center mb-2">Something went wrong</h1>
            <p className="text-sm text-stone-500 text-center mb-5">
              The app hit an unexpected error and couldn't recover automatically.
            </p>
            <div className="bg-stone-50 border border-stone-200 rounded-xl p-3 mb-5 text-xs text-stone-700 font-mono max-h-40 overflow-y-auto">
              <div className="font-bold text-rose-700 mb-1">{this.state.error?.name}: {this.state.error?.message}</div>
              {this.state.error?.stack && (
                <pre className="whitespace-pre-wrap break-words text-stone-500 text-[10px]">{this.state.error.stack.split("\n").slice(0, 8).join("\n")}</pre>
              )}
              {this.state.errorInfo && (
                <pre className="whitespace-pre-wrap break-words text-stone-400 text-[10px] mt-2 border-t border-stone-200 pt-2">
                  {this.state.errorInfo.split("\n").slice(0, 6).join("\n")}
                </pre>
              )}
            </div>
            <div className="flex gap-2">
              <button
                onClick={this.handleReset}
                className="flex-1 bg-stone-100 hover:bg-stone-200 text-stone-800 font-bold py-2.5 rounded-xl text-sm transition-colors cursor-pointer"
              >
                Try Again
              </button>
              <button
                onClick={this.handleReload}
                className="flex-1 bg-stone-900 hover:bg-amber-600 text-white font-bold py-2.5 rounded-xl text-sm transition-colors cursor-pointer"
              >
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