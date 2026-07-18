import { Component, type ReactNode } from "react";
import { RotateCcw, TriangleAlert } from "lucide-react";
import { friendlyError } from "../lib/errors";

interface ErrorBoundaryProps {
  label: string;
  children: ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="view-error" role="alert">
        <TriangleAlert size={19} />
        <div>
          <strong>The {this.props.label} view hit a problem</strong>
          <small>{friendlyError(this.state.error)}</small>
        </div>
        <button className="secondary-button" onClick={() => this.setState({ error: null })}>
          <RotateCcw size={13} /> Reload view
        </button>
      </div>
    );
  }
}
