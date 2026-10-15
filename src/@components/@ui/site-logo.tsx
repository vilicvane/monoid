import {IonIcon} from '@ionic/react';
import globe from 'lucide-static/icons/globe.svg';
import type {ReactNode} from 'react';
import {useEffect, useState} from 'react';
import {styled} from 'styled-components';

import {getSiteLogoUrls} from '../../@lib/site-logo.js';

const Container = styled.div<{$loaded: boolean}>`
  display: grid;
  flex: 0 0 56px;
  grid-template: 1fr / 1fr;
  place-items: center;
  box-sizing: border-box;
  width: 56px;
  height: 56px;
  overflow: hidden;
  border-radius: 14px;
  background: ${props =>
    props.$loaded ? 'transparent' : 'var(--ion-color-light)'};
  color: var(--color-text-secondary);
  font-size: 24px;
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
}: {
  name: string;
  url: string;
  icons: readonly string[];
}): ReactNode {
  const urls = getSiteLogoUrls(url, icons);

  return (
    <SiteLogoImage
      key={JSON.stringify([name, url, urls])}
      name={name}
      urls={urls}
    />
  );
}

function SiteLogoImage({
  name,
  urls,
}: {
  name: string;
  urls: readonly string[];
}): ReactNode {
  const [{index, loaded}, setImage] = useState({index: 0, loaded: false});
  const src = urls[index];

  useEffect(() => {
    if (!src || loaded) {
      return;
    }

    const timer = window.setTimeout(() => {
      setImage(image =>
        image.index === index && !image.loaded
          ? {index: index + 1, loaded: false}
          : image,
      );
    }, 8000);

    return () => window.clearTimeout(timer);
  }, [src, index, loaded]);

  return (
    <Container aria-hidden="true" $loaded={loaded}>
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
          src={src}
          alt=""
          referrerPolicy="no-referrer"
          $loaded={loaded}
          onLoad={() =>
            setImage(image =>
              image.index === index ? {...image, loaded: true} : image,
            )
          }
          onError={() =>
            setImage(image =>
              image.index === index ? {index: index + 1, loaded: false} : image,
            )
          }
        />
      )}
    </Container>
  );
}
