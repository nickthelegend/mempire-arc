import { Component, type ErrorInfo, type ReactNode } from 'react';
import { Pill } from './ui';

interface Props { children: ReactNode }
interface State { error: Error | null }

/**
 * A crash mid-match would otherwise white-screen the app with a stake already
 * escrowed. R3F re-throws canvas failures to the parent, so this also catches
 * WebGL init and asset-load errors.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('Mempire crashed:', error, info.componentStack);
  }

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    // .quilt on the root: this boundary wraps the router, so without it a crash
    // also loses the field and the app drops to a flat blue rectangle.
    return (
      <div
        role="alert"
        className="quilt"
        style={{
          minHeight: '100dvh', display: 'flex', flexDirection: 'column',
          alignItems: 'center', justifyContent: 'center', gap: 16,
          padding: 28, textAlign: 'center',
        }}
      >
        <h1 className="display" style={{ fontSize: 30 }}>Something broke</h1>
        <p style={{ color: 'var(--dim)', fontSize: 14, maxWidth: 320 }}>
          The arena crashed. Any escrowed stake is recoverable from the match
          account — nothing is lost onchain.
        </p>
        <code
          className="well"
          style={{
            fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--red-on-wood)',
            maxWidth: 320, wordBreak: 'break-word', padding: '9px 12px',
            display: 'block',
          }}
        >
          {error.message}
        </code>
        <div style={{ width: 'min(100%, 280px)' }}>
          <Pill onClick={() => { window.location.hash = '#/'; window.location.reload(); }}>
            Back to Arena
          </Pill>
        </div>
      </div>
    );
  }
}
