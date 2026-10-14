/**
 * Quick Chat Icons
 *
 * SVG icons used in the Quick Chat component.
 * Extracted here to keep the main component clean and avoid magic strings.
 */

import React from 'react';

export function SearchIcon(props: React.SVGProps<SVGSVGElement>) {
    return (
        <svg
            width="20"
            height="20"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            {...props}
        >
            <circle cx="11" cy="11" r="8" />
            <path d="m21 21-4.3-4.3" />
        </svg>
    );
}

export function SendIcon(props: React.SVGProps<SVGSVGElement>) {
    return (
        <svg
            width="20"
            height="20"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            {...props}
        >
            <path d="m22 2-7 20-4-9-9-4Z" />
            <path d="M22 2 11 13" />
        </svg>
    );
}

/** Shared frame for the small 16px line icons used in the agent panel. */
function LineIcon({ children, ...props }: React.SVGProps<SVGSVGElement>) {
    return (
        <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
            focusable="false"
            {...props}
        >
            {children}
        </svg>
    );
}

export function StopIcon(props: React.SVGProps<SVGSVGElement>) {
    return (
        <LineIcon {...props}>
            <rect x="6" y="6" width="12" height="12" rx="2" />
        </LineIcon>
    );
}

export function ToolIcon(props: React.SVGProps<SVGSVGElement>) {
    return (
        <LineIcon {...props}>
            <path d="m4 17 6-6-6-6" />
            <path d="M12 19h8" />
        </LineIcon>
    );
}

export function CheckIcon(props: React.SVGProps<SVGSVGElement>) {
    return (
        <LineIcon {...props}>
            <path d="M20 6 9 17l-5-5" />
        </LineIcon>
    );
}

export function ErrorIcon(props: React.SVGProps<SVGSVGElement>) {
    return (
        <LineIcon {...props}>
            <circle cx="12" cy="12" r="9" />
            <path d="M12 8v4" />
            <path d="M12 16h.01" />
        </LineIcon>
    );
}

export function LockIcon(props: React.SVGProps<SVGSVGElement>) {
    return (
        <LineIcon {...props}>
            <rect x="5" y="11" width="14" height="10" rx="2" />
            <path d="M8 11V7a4 4 0 0 1 8 0v4" />
        </LineIcon>
    );
}

export function MoveIcon(props: React.SVGProps<SVGSVGElement>) {
    return (
        <LineIcon {...props}>
            <path d="M5 12h14" />
            <path d="m13 6 6 6-6 6" />
        </LineIcon>
    );
}

export function CopyIcon(props: React.SVGProps<SVGSVGElement>) {
    return (
        <LineIcon {...props}>
            <rect x="9" y="9" width="11" height="11" rx="2" />
            <path d="M5 15V5a2 2 0 0 1 2-2h8" />
        </LineIcon>
    );
}

export function RenameIcon(props: React.SVGProps<SVGSVGElement>) {
    return (
        <LineIcon {...props}>
            <path d="M12 20h9" />
            <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
        </LineIcon>
    );
}

export function FolderPlusIcon(props: React.SVGProps<SVGSVGElement>) {
    return (
        <LineIcon {...props}>
            <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />
            <path d="M12 11v4" />
            <path d="M10 13h4" />
        </LineIcon>
    );
}

export function TrashIcon(props: React.SVGProps<SVGSVGElement>) {
    return (
        <LineIcon {...props}>
            <path d="M3 6h18" />
            <path d="M8 6V4h8v2" />
            <path d="M6 6l1 14h10l1-14" />
        </LineIcon>
    );
}
