import {IonIcon} from '@ionic/react';
import globe from 'lucide-static/icons/globe.svg';
import type {ReactNode} from 'react';
import {useCallback, useEffect, useRef, useState} from 'react';
import {styled} from 'styled-components';

import {getSiteLogoUrls} from '../../@lib/site-logo.js';

const loadedLogos = new Map<string, number>();

const Container = styled.div<{$loaded: boolean; $size: number}>`
  display: grid;
  flex: 0 0 ${props => props.$size}px;
  grid-template: 1fr / 1fr;
  place-items: center;
  box-sizing: border-box;
  width: ${props => props.$size}px;
  height: ${props => props.$size}px;
  overflow: hidden;
  border-radius: ${props => props.$size / 4}px;
  background: ${props =>
    props.$loaded ? 'transparent' : 'var(--ion-color-light)'};
  color: var(--color-text-secondary);
  font-size: ${props => (props.$size * 3) / 7}px;
  font-weight: 500;

  > * {
    grid-area: 1 / 1;
  }
`;

const Logo = styled.img<{$loaded: boolean}>`
  display: block;
  width: 100%;
  height: 100%;
  min-width: 0;
  min-height: 0;
  object-fit: contain;
  opacity: ${props => (props.$loaded ? 1 : 0)};
  transition: opacity 150ms;

  @media (prefers-reduced-motion: reduce) {
    transition: none;
  }
`;

export function SiteLogo({
  name,
  url,
  icons,
  size = 56,
}: {
  name: string;
  url: string;
  icons: readonly string[];
  size?: number;
}): ReactNode {
  const urls = getSiteLogoUrls(url, icons);

  return (
    <SiteLogoImage
      key={JSON.stringify([name, url, urls])}
      name={name}
      urls={urls}
      size={size}
    />
  );
}

function SiteLogoImage({
  name,
  urls,
  size,
}: {
  name: string;
  urls: readonly string[];
  size: number;
}): ReactNode {
  const cacheKey = JSON.stringify(urls);
  const [{index, loaded}, setImage] = useState(() => {
    const index = loadedLogos.get(cacheKey);
    return {index: index ?? 0, loaded: index !== undefined};
  });
  const imageRef = useRef<HTMLImageElement>(null);
  const src = urls[index];

  const nextImage = useCallback(() => {
    if (loadedLogos.get(cacheKey) === index) loadedLogos.delete(cacheKey);
    setImage(image =>
      image.index === index ? {index: index + 1, loaded: false} : image,
    );
  }, [cacheKey, index]);

  useEffect(() => {
    const image = imageRef.current;
    if (!src || (image?.complete && image.naturalWidth > 0)) {
      return;
    }

    const timer = window.setTimeout(() => {
      if (!image?.complete || !image.naturalWidth) nextImage();
    }, 8000);

    return () => window.clearTimeout(timer);
  }, [src, loaded, nextImage]);

  return (
    <Container aria-hidden="true" $loaded={loaded} $size={size}>
      {!loaded && (
        <span>
          {Array.from(name.trim())[0]?.toUpperCase() || (
            <IonIcon icon={globe} />
          )}
        </span>
      )}
      {src && (
        <Logo
          key={src}
          ref={imageRef}
          src={src}
          alt=""
          referrerPolicy="no-referrer"
          $loaded={loaded}
          onLoad={() => {
            loadedLogos.set(cacheKey, index);
            setImage(image =>
              image.index === index ? {...image, loaded: true} : image,
            );
          }}
          onError={nextImage}
        />
      )}
    </Container>
  );
}
