import {Nfc, NfcTagTechType} from '@capawesome-team/capacitor-nfc';
import './ExploreContainer.css';
import {useEffect} from 'react';

interface ContainerProps {
  name: string;
}

const ExploreContainer: React.FC<ContainerProps> = ({name}) => {
  console.log('hello');

  useEffect(() => {
    Nfc.addListener('nfcTagScanned', async event => {
      if (event.nfcTag.techTypes?.includes(NfcTagTechType.IsoDep) !== true) {
        console.log('not iso dep');
        return;
      }

      console.log('iso dep');

      try {
        await Nfc.connect({
          techType: NfcTagTechType.IsoDep,
        });

        const commands = [
          [
            0x00, 0xa4, 0x04, 0x00, 0x0b, 0xf1, 0x6d, 0x6f, 0x6e, 0x6f, 0x69,
            0x64, 0x01, 0x01, 0x00, 0x01,
          ],
          hexToBytes(
            '00020000' +
              '29' + // 9 + 32
              '0146ff63fe77296ed7' + // index
              '9c22ff5f21f0b81b113e63f7db6da94fedef11b2119b4088b89664fb9a3cb658', // hash
          ),
        ];

        for (const command of commands) {
          const response = await Nfc.transceive({
            data: command,
          });
          console.log(
            response.response
              .map(b => b.toString(16).padStart(2, '0'))
              .join(''),
          );
        }
      } catch (error) {
        console.error(error);
      }
    });

    return () => {
      Nfc.removeAllListeners();
    };
  }, []);

  return (
    <div className="container">
      <strong>{name}</strong>
      <p>
        Explore{' '}
        <a
          target="_blank"
          rel="noopener noreferrer"
          href="https://ionicframework.com/docs/components"
        >
          UI Components
        </a>
      </p>
      <div>
        <button style={{fontSize: '30px'}} onClick={async () => {}}>
          Hello
        </button>
      </div>
    </div>
  );
};

export default ExploreContainer;

function hexToBytes(hex: string): number[] {
  return hex.match(/.{2}/g)?.map(byte => parseInt(byte, 16)) ?? [];
}
