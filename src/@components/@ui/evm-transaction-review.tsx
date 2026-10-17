import {type TransactionLike, accessListify, getBigInt} from 'ethers';
import {observer} from 'mobx-react-lite';
import {
  type ComponentProps,
  type ReactNode,
  useEffect,
  useMemo,
  useState,
} from 'react';

import {useEntrances} from '../../@entrances.js';
import type {EvmCalldata} from '../../@lib/evm-calldata.js';
import type {EvmGasSettings} from '../../@lib/evm-gas-settings.js';
import {
  type EvmGasEstimate,
  type EvmGasTransaction,
  estimateEvmGas,
} from '../../@lib/evm-gas.js';
import {getErc20CallTarget} from '../../@lib/evm-token.js';
import {getTypedDataFields} from '../../@lib/typed-data-fields.js';

import {EvmGasDetails} from './evm-gas-details.js';
import {EvmTransactionData} from './evm-transaction-data.js';
import {ExpandableAddress} from './expandable-address.js';
import {
  InfoFieldset,
  InfoFieldsetValue,
  InfoLegend,
  InfoSection,
  InfoSectionHeader,
  InfoSectionLoadingSpinner,
} from './info-section.js';
import {ErrorMessage, MessageSectionTitle} from './message-content.js';
import {NativeAmount} from './native-amount.js';
import {TypedDataFields} from './typed-data-fields.js';

export const TRANSACTION_TYPE_LABELS: Record<number, string> = {
  0: 'Legacy',
  1: 'EIP-2930',
  2: 'EIP-1559',
};

export const EvmTransactionReview = observer(
  ({
    transaction,
    decodedData,
    preparing,
    showGas = true,
    error,
    onGasChange,
    minimumGas,
    ...addressProps
  }: {
    transaction: TransactionLike<string>;
    decodedData?: EvmCalldata;
    preparing: boolean;
    showGas?: boolean;
    error?: string;
    onGasChange?: (settings: EvmGasSettings) => void;
    minimumGas?: EvmGasSettings;
  } & Pick<
    ComponentProps<typeof TypedDataFields>,
    'getAddressKind' | 'getAddressMark' | 'onAddressClick'
  >): ReactNode => {
    const {chainService, evmTokenService} = useEntrances();
    const chainId = `eip155:${transaction.chainId}`;
    const currency = chainService.getNativeCurrency(chainId);
    const amount = getBigInt(transaction.value ?? 0);
    const tokenTarget = decodedData && getErc20CallTarget(decodedData);
    const showToken =
      tokenTarget &&
      tokenTarget.toLowerCase() === transaction.to?.toLowerCase() &&
      !!evmTokenService.getToken(chainId, tokenTarget);
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
    const [estimate, setEstimate] = useState<{
      chainId: string;
      transaction: EvmGasTransaction;
      value: EvmGasEstimate;
    }>();
    const currentEstimate =
      estimate?.chainId === chainId && estimate.transaction === gas
        ? estimate.value
        : undefined;

    useEffect(() => {
      if (!showGas || preparing || !gas) return;
      let cancelled = false;

      void chainService
        .getRPC(chainId)
        .then(provider => estimateEvmGas(gas, provider))
        .catch((): EvmGasEstimate => ({}))
        .then(value => {
          if (!cancelled) setEstimate({chainId, transaction: gas, value});
        });

      return () => {
        cancelled = true;
      };
    }, [chainService, chainId, gas, preparing, showGas]);

    const accessList = transaction.accessList
      ? accessListify(transaction.accessList)
      : [];

    return (
      <>
        {!showToken && (
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
        )}
        {amount !== BigInt(0) && (
          <InfoFieldset $equalPadding>
            <InfoLegend>Amount</InfoLegend>
            <InfoFieldsetValue>
              <NativeAmount value={amount} currency={currency} />
            </InfoFieldsetValue>
          </InfoFieldset>
        )}
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
        {!showGas ? null : !preparing && gas && currentEstimate ? (
          <EvmGasDetails
            chainId={chainId}
            transaction={gas}
            estimate={currentEstimate}
            currency={currency}
            showFees={!error}
            onChange={onGasChange}
            minimum={minimumGas}
          />
        ) : preparing || gas ? (
          <InfoSection>
            <InfoSectionHeader>
              <MessageSectionTitle>Gas</MessageSectionTitle>
              <InfoSectionLoadingSpinner aria-label="Estimating gas" />
            </InfoSectionHeader>
          </InfoSection>
        ) : null}
        {error && <ErrorMessage>{error}</ErrorMessage>}
      </>
    );
  },
);
