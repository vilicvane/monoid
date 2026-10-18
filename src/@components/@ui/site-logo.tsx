import {Globe as globe} from 'lucide-react';
import type {ReactNode} from 'react';
import {useCallback, useEffect, useRef, useState} from 'react';
import {styled} from 'styled-components';

import {useEntrances} from '../../@entrances.js';
import {getSiteLogoUrls} from '../../@lib/site-logo.js';

import {AppIcon} from './app-icon.js';

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
  const {siteLogoService} = useEntrances();
  const [{sources, index, src, loaded}, setImage] = useState(() => {
    const cached = siteLogoService.getCached(urls);
    return {
      sources: cached
        ? [cached.url, ...urls.filter(url => url !== cached.url)]
        : urls,
      index: 0,
      src: cached?.src,
      loaded: !!cached,
    };
  });
  const imageRef = useRef<HTMLImageElement>(null);
  const url = sources[index];

  const nextImage = useCallback(() => {
    if (url) siteLogoService.remove(url);
    setImage(image =>
      image.index === index
        ? {...image, index: index + 1, src: undefined, loaded: false}
        : image,
    );
  }, [siteLogoService, url, index]);

  useEffect(() => {
    if (!url) return;

    let active = true;

    void siteLogoService
      .load(url)
      // A browser may display a cross-origin image even when CORS prevents caching it.
      .catch(() => url)
      .then(src => {
        if (active) {
          setImage(image => (image.index === index ? {...image, src} : image));
        }
      });

    return () => {
      active = false;
    };
  }, [siteLogoService, url, index]);

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
            <AppIcon icon={globe} />
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
