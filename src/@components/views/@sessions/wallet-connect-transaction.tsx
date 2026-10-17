import {type TransactionLike, accessListify, getBigInt} from 'ethers';
import {observer} from 'mobx-react-lite';
import {type ComponentProps, type ReactNode, useMemo} from 'react';

import {useEntrances} from '../../../@entrances.js';
import type {EvmCalldata} from '../../../@lib/evm-calldata.js';
import type {EvmGasSettings} from '../../../@lib/evm-gas-settings.js';
import type {EvmGasTransaction} from '../../../@lib/evm-gas.js';
import {getTypedDataFields} from '../../../@lib/typed-data-fields.js';
import {EvmGasDetails} from '../../@ui/evm-gas-details.js';
import {EvmTransactionData} from '../../@ui/evm-transaction-data.js';
import {ExpandableAddress} from '../../@ui/expandable-address.js';
import {
  InfoFieldset,
  InfoFieldsetValue,
  InfoLegend,
  InfoSection,
  InfoSectionHeader,
} from '../../@ui/info-section.js';
import {LoadingSpinner} from '../../@ui/loading-spinner.js';
import {ErrorMessage, MessageSectionTitle} from '../../@ui/message-content.js';
import {NativeAmount} from '../../@ui/native-amount.js';
import {TypedDataFields} from '../../@ui/typed-data-fields.js';

export const TRANSACTION_TYPE_LABELS: Record<number, string> = {
  0: 'Legacy',
  1: 'EIP-2930',
  2: 'EIP-1559',
};

export const WalletConnectTransaction = observer(
  ({
    transaction,
    decodedData,
    preparing,
    error,
    onGasChange,
    ...addressProps
  }: {
    transaction: TransactionLike<string>;
    decodedData?: EvmCalldata;
    preparing: boolean;
    error?: string;
    onGasChange?: (settings: EvmGasSettings) => void;
  } & Pick<
    ComponentProps<typeof TypedDataFields>,
    'getAddressKind' | 'getAddressMark' | 'onAddressClick'
  >): ReactNode => {
    const {chainService} = useEntrances();
    const chainId = `eip155:${transaction.chainId}`;
    const currency = chainService.getNativeCurrency(chainId);
    const gas = useMemo((): EvmGasTransaction | undefined => {
      const {type, gasLimit, gasPrice, maxFeePerGas, maxPriorityFeePerGas} =
        transaction;
      if (
        type == null ||
        gasLimit == null ||
        (type === 2
          ? maxFeePerGas == null || maxPriorityFeePerGas == null
          : gasPrice == null)
      )
        return undefined;

      return {
        type,
        gasLimit: getBigInt(gasLimit),
        gasPrice: gasPrice == null ? null : getBigInt(gasPrice),
        maxFeePerGas: maxFeePerGas == null ? null : getBigInt(maxFeePerGas),
        maxPriorityFeePerGas:
          maxPriorityFeePerGas == null ? null : getBigInt(maxPriorityFeePerGas),
      };
    }, [transaction]);
    const accessList = transaction.accessList
      ? accessListify(transaction.accessList)
      : [];

    return (
      <>
        <InfoFieldset>
          <InfoLegend>To</InfoLegend>
          {transaction.to ? (
            <ExpandableAddress
              kind={addressProps.getAddressKind?.(transaction.to)}
              mark={addressProps.getAddressMark?.(transaction.to)}
              onClick={
                addressProps.onAddressClick
                  ? () => addressProps.onAddressClick!(transaction.to!)
                  : undefined
              }
            >
              {transaction.to}
            </ExpandableAddress>
          ) : (
            <span>Contract creation</span>
          )}
        </InfoFieldset>
        <InfoFieldset $equalPadding>
          <InfoLegend>Amount</InfoLegend>
          <InfoFieldsetValue>
            <NativeAmount
              value={getBigInt(transaction.value ?? 0)}
              currency={currency}
            />
          </InfoFieldsetValue>
        </InfoFieldset>
        <EvmTransactionData
          chainId={chainId}
          data={transaction.data ?? '0x'}
          decoded={decodedData}
          {...addressProps}
        />
        {!!accessList.length && (
          <InfoSection>
            <MessageSectionTitle>Access list</MessageSectionTitle>
            <TypedDataFields
              {...addressProps}
              label="Transaction access list"
              fields={accessList.map((entry, index) => ({
                name: `[${index}]`,
                type: 'AccessListEntry',
                kind: 'struct',
                children: getTypedDataFields(
                  {
                    AccessListEntry: [
                      {name: 'address', type: 'address'},
                      {name: 'storageKeys', type: 'bytes32[]'},
                    ],
                  },
                  'AccessListEntry',
                  entry,
                ),
              }))}
            />
          </InfoSection>
        )}
        {!preparing && gas ? (
          <EvmGasDetails
            chainId={chainId}
            transaction={gas}
            currency={currency}
            showFees={!error}
            onChange={onGasChange}
          />
        ) : (
          <InfoSection>
            <InfoSectionHeader>
              <MessageSectionTitle>Gas</MessageSectionTitle>
              {preparing && <LoadingSpinner aria-label="Estimating gas" />}
            </InfoSectionHeader>
          </InfoSection>
        )}
        {error && <ErrorMessage>{error}</ErrorMessage>}
      </>
    );
  },
);
