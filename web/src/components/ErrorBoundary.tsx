import { Component, type ErrorInfo, type ReactNode } from "react";
import { IconAlert } from "./Icons";

interface Props {
	children: ReactNode;
	label?: string;
	fallback?: (error: Error) => ReactNode;
}

interface State {
	error: Error | null;
}

/**
 * Wrap each codex item renderer. The protocol is experimental — one malformed
 * item must never blank the whole transcript.
 */
export class ErrorBoundary extends Component<Props, State> {
	state: State = { error: null };

	static getDerivedStateFromError(error: Error): State {
		return { error };
	}

	componentDidCatch(error: Error, info: ErrorInfo): void {
		// eslint-disable-next-line no-console
		console.warn("[open-web-app] item renderer crashed", error, info.componentStack);
	}

	render(): ReactNode {
		const { error } = this.state;
		if (!error) return this.props.children;
		if (this.props.fallback) return this.props.fallback(error);
		return (
			<div className="item item-generic item-error-card">
				<div className="item-head">
					<span className="item-icon item-icon-error">
						<IconAlert size={15} />
					</span>
					<span className="item-title">Render error{this.props.label ? `: ${this.props.label}` : ""}</span>
				</div>
				<pre className="code-block small">{error.message}</pre>
			</div>
		);
	}
}
