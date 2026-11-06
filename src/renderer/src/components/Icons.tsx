type IconName =
  | 'mark'
  | 'folder'
  | 'folder-open'
  | 'file'
  | 'chevron'
  | 'chevron-down'
  | 'search'
  | 'settings'
  | 'close'
  | 'branch'
  | 'terminal'
  | 'alert'
  | 'plus'
  | 'refresh'
  | 'send'
  | 'zap'
  | 'activity'
  | 'check'
  | 'cpu'
  | 'disk'

type IconProps = {
  name: IconName
  className?: string
}

export function Icon({ name, className }: IconProps) {
  const common = {
    className,
    viewBox: '0 0 16 16',
    width: 14,
    height: 14,
    fill: 'none',
    'aria-hidden': true as const
  }
  switch (name) {
    case 'mark':
      return (
        <svg {...common} width={14} height={14} viewBox="0 0 24 24">
          <path d="M12 2 2 7l10 5 10-5L12 2Z" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
          <path d="M2 12l10 5 10-5" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
          <path d="M2 17l10 5 10-5" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
        </svg>
      )
    case 'folder':
      return (
        <svg {...common}>
          <path d="M2.2 4.2h4l1.2 1.4h6.4v7.8H2.2V4.2Z" stroke="currentColor" strokeWidth="1.2" />
        </svg>
      )
    case 'folder-open':
      return (
        <svg {...common}>
          <path d="M2 6.2h12v6.6H2V6.2Zm0-1.4h4l1 1.2h7" stroke="currentColor" strokeWidth="1.2" />
        </svg>
      )
    case 'file':
      return (
        <svg {...common}>
          <path d="M4 1.6h5.2L13 5.2v9.2H4V1.6Z" stroke="currentColor" strokeWidth="1.2" />
          <path d="M9.2 1.6V5.2H13" stroke="currentColor" strokeWidth="1.2" />
        </svg>
      )
    case 'chevron':
      return (
        <svg {...common}>
          <path d="M6 3.2 10.8 8 6 12.8" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
        </svg>
      )
    case 'chevron-down':
      return (
        <svg {...common}>
          <path d="M3.2 6 8 10.8 12.8 6" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
        </svg>
      )
    case 'search':
      return (
        <svg {...common}>
          <circle cx="7" cy="7" r="4.1" stroke="currentColor" strokeWidth="1.3" />
          <path d="M10.2 10.2 13.4 13.4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
        </svg>
      )
    case 'settings':
      return (
        <svg {...common}>
          <circle cx="8" cy="8" r="2" stroke="currentColor" strokeWidth="1.2" />
          <path d="M8 1.8v2M8 12.2v2M1.8 8h2M12.2 8h2M3.5 3.5l1.4 1.4M11.1 11.1l1.4 1.4M12.5 3.5 11.1 4.9M4.9 11.1 3.5 12.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
        </svg>
      )
    case 'close':
      return (
        <svg {...common}>
          <path d="M4 4l8 8M12 4 4 12" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
        </svg>
      )
    case 'branch':
      return (
        <svg {...common}>
          <circle cx="4.2" cy="3.4" r="1.3" stroke="currentColor" strokeWidth="1.2" />
          <circle cx="4.2" cy="12.6" r="1.3" stroke="currentColor" strokeWidth="1.2" />
          <circle cx="11.8" cy="6.2" r="1.3" stroke="currentColor" strokeWidth="1.2" />
          <path d="M4.2 4.8v6.4M4.2 7.6h6.2V7.5" stroke="currentColor" strokeWidth="1.2" />
        </svg>
      )
    case 'terminal':
      return (
        <svg {...common}>
          <path d="M2.8 4.4 7 8l-4.2 3.6M8.4 12.2H13" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      )
    case 'alert':
      return (
        <svg {...common}>
          <circle cx="8" cy="8" r="5.4" stroke="currentColor" strokeWidth="1.2" />
          <path d="M8 5v3.4M8 11.1h.01" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
        </svg>
      )
    case 'plus':
      return (
        <svg {...common}>
          <path d="M8 3.2v9.6M3.2 8h9.6" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
        </svg>
      )
    case 'refresh':
      return (
        <svg {...common}>
          <path d="M13 8a5 5 0 1 1-1.4-3.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
          <path d="M13 2.8V6H9.8" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      )
    case 'send':
      return (
        <svg {...common}>
          <path d="M2.5 8 13.5 2.8 8.6 13.5 7.2 8.8 2.5 8Z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
        </svg>
      )
    case 'zap':
      return (
        <svg {...common}>
          <path d="M8.8 1.6 3.4 9h4.2l-.8 5.4 5.6-7.6H8.2L8.8 1.6Z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
        </svg>
      )
    case 'activity':
      return (
        <svg {...common}>
          <path d="M1.8 8h2.4l1.6-3.2L8.6 11l1.6-3H14.2" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      )
    case 'check':
      return (
        <svg {...common}>
          <circle cx="8" cy="8" r="5.4" stroke="currentColor" strokeWidth="1.2" />
          <path d="M5.4 8.2 7.2 10l3.4-3.6" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
        </svg>
      )
    case 'cpu':
      return (
        <svg {...common}>
          <rect x="4.2" y="4.2" width="7.6" height="7.6" rx="1" stroke="currentColor" strokeWidth="1.2" />
          <path d="M6.4 1.8v2M9.6 1.8v2M6.4 12.2v2M9.6 12.2v2M1.8 6.4h2M1.8 9.6h2M12.2 6.4h2M12.2 9.6h2" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
        </svg>
      )
    case 'disk':
      return (
        <svg {...common}>
          <rect x="2.2" y="3" width="11.6" height="10" rx="1.2" stroke="currentColor" strokeWidth="1.2" />
          <path d="M2.2 6.2h11.6M5 11h3" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
        </svg>
      )
  }
}

export function fileTone(name: string): string {
  const extension = name.split('.').pop()?.toLowerCase()
  if (extension === 'tsx' || extension === 'jsx') {
    return 'tone-cyan'
  }
  if (extension === 'ts' || extension === 'js' || extension === 'mjs') {
    return 'tone-amber'
  }
  if (extension === 'json') {
    return 'tone-emerald'
  }
  if (extension === 'css' || extension === 'html') {
    return 'tone-blue'
  }
  if (extension === 'md') {
    return 'tone-slate'
  }
  return 'tone-slate'
}
