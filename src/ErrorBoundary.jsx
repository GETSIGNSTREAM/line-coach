'use client';

import { Component } from 'react';

// Root error boundary for the kitchen surfaces. These screens run
// unattended on wall-mounted hardware, so a single render-time throw
// (a malformed order, an unexpected null) must NOT blank the whole
// board until someone notices and reloads. We catch the error, show a
// calm fallback, and auto-retry on a short interval — a transient bad
// row clears itself the moment it bumps or ages out of the feed.
export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false };
    this.retryTimer = null;
  }

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  componentDidCatch(error, info) {
    // Surface to the console for remote debugging; never throw from here.
    console.error('Line Coach render error (recovered):', error, info?.componentStack);
    if (!this.retryTimer) {
      this.retryTimer = setInterval(() => {
        // Drop back to rendering children. If they still throw, the
        // boundary re-catches and this keeps trying; if the offending
        // data is gone, the board comes back on its own.
        this.setState({ hasError: false });
      }, 4000);
    }
  }

  componentDidUpdate(prevProps, prevState) {
    // A clean re-render after an error → stop retrying.
    if (prevState.hasError && !this.state.hasError && this.retryTimer) {
      clearInterval(this.retryTimer);
      this.retryTimer = null;
    }
  }

  componentWillUnmount() {
    if (this.retryTimer) clearInterval(this.retryTimer);
  }

  render() {
    if (this.state.hasError) {
      return this.props.fallback ?? (
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          height: '100vh', background: '#1a1a2e', color: '#EDE6D6',
          fontFamily: "'Oswald', sans-serif", fontSize: '1.4rem',
          letterSpacing: '1px', textAlign: 'center', padding: '24px',
        }}>
          Reconnecting…
        </div>
      );
    }
    return this.props.children;
  }
}
