interface KharaGolfBrandProps {
  size?: 'sm' | 'md' | 'lg' | 'xl';
  showLogo?: boolean;
  showTagline?: boolean;
  tagline?: string;
  className?: string;
  logoClassName?: string;
  textClassName?: string;
}

const SIZE_LOGO: Record<string, string> = {
  sm:  'w-8 h-8',
  md:  'w-12 h-12',
  lg:  'w-16 h-16',
  xl:  'w-24 h-24',
};
const SIZE_TEXT: Record<string, string> = {
  sm:  'text-base',
  md:  'text-xl',
  lg:  'text-3xl',
  xl:  'text-4xl',
};
const SIZE_TAG: Record<string, string> = {
  sm:  'text-[9px]',
  md:  'text-xs',
  lg:  'text-sm',
  xl:  'text-base',
};

const GOLD = '#C9A84C';

export function KharaGolfBrand({
  size = 'lg',
  showLogo = true,
  showTagline = false,
  tagline = '',
  className = '',
  logoClassName = '',
  textClassName = '',
}: KharaGolfBrandProps) {
  return (
    <div className={`flex flex-col items-center ${className}`}>
      {showLogo && (
        <img
          src="/logo.png"
          alt="KHARAGOLF Logo"
          className={`${SIZE_LOGO[size]} object-contain mb-3 drop-shadow-lg ${logoClassName}`}
        />
      )}
      <h1
        className={`font-display font-black tracking-widest uppercase leading-none ${SIZE_TEXT[size]} ${textClassName}`}
        style={{ color: '#ffffff' }}
      >
        KHARA<span style={{ color: GOLD }}>GOLF</span>
      </h1>
      {showTagline && tagline && (
        <p
          className={`font-semibold tracking-widest mt-1 ${SIZE_TAG[size]}`}
        >
          <span style={{ color: GOLD }}>{tagline}</span>
        </p>
      )}
    </div>
  );
}

export function KharaGolfWordmark({ className = '' }: { className?: string }) {
  return (
    <span className={`font-display font-black tracking-widest uppercase ${className}`}>
      <span style={{ color: '#ffffff' }}>KHARA</span>
      <span style={{ color: GOLD }}>GOLF</span>
    </span>
  );
}
