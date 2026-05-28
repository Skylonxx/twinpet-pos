import './ProductImageThumb.css';

type ProductImageThumbProps = {
  imageUrl?: string | null;
  alt?: string;
  variant?: 'pos' | 'thumb';
  className?: string;
};

export default function ProductImageThumb({
  imageUrl,
  alt = '',
  variant = 'thumb',
  className,
}: ProductImageThumbProps) {
  const cls = ['product-img', `product-img--${variant}`, className].filter(Boolean).join(' ');

  if (imageUrl) {
    return (
      <div className={cls}>
        <img src={imageUrl} alt={alt} />
      </div>
    );
  }

  return (
    <div className={cls} aria-hidden={!alt}>
      <i className="ti ti-package" aria-hidden="true" />
    </div>
  );
}
