import React, {useCallback} from 'react';
import {useStyletron} from 'baseui';
import {StatefulDataTable, CategoricalColumn, StringColumn, BooleanColumn} from 'baseui/data-table';
import {MobileHeader} from 'baseui/mobile-header';
import {TbAnalyze} from 'react-icons/tb';
import Head from 'next/head';
import {useAtomValue} from 'jotai';
import {configFetcherWmAtom, currentUrlAtom__wm_config, currentWmAtom} from '@/state';
import useSWR from 'swr';
import {toaster} from 'baseui/toast';
import {PageWrapper} from '@/utils';
import {FiTrash2} from 'react-icons/fi';

const columns = [
  CategoricalColumn({
    title: 'PID',
    mapDataToValue: (data) => data.pid.toString(),
  }),
  StringColumn({
    title: 'Operator Account Id',
    mapDataToValue: (data) => data.operator_account_id,
  }),
  StringColumn({
    title: 'Proxied Account Id',
    mapDataToValue: (data) => data.proxied_account_id,
  }),
];

const reqGetAllPools = '"GetAllPoolOperators"';

export default function PoolOperatorInvPage() {
  const [css] = useStyletron();
  const currWm = useAtomValue(currentWmAtom);
  const rawFetcher = useAtomValue(configFetcherWmAtom);
  const url = useAtomValue(currentUrlAtom__wm_config);
  const fetcher = useCallback((f) => rawFetcher(f).then((r) => r.map((data) => ({id: data.id, data}))), [rawFetcher]);
  const {data, isLoading, mutate} = useSWR([url, reqGetAllPools], fetcher, {refreshInterval: 15000});

  return (
    <>
      <Head>
        <title>{currWm ? currWm.name + ' - ' : ''}Pool Operator Config</title>
      </Head>
      <PageWrapper>
        <div
          className={css({
            width: '100%',
            flex: 1,
            marginRight: '24px',
            display: 'flex',
          })}
        >
          <MobileHeader
            title={`Inventory - Pool Operators (${data?.length || 0})`}
            navButton={
              isLoading
                ? {
                    renderIcon: () => <TbAnalyze size={24} className="spin" />,
                    onClick: () => {},
                    label: 'Loading',
                  }
                : {
                    renderIcon: () => <TbAnalyze size={24} />,
                    onClick: () => {
                      mutate().then(() => toaster.positive('Reloaded'));
                    },
                    label: 'Reload',
                  }
            }
            actionButtons={[
              {
                label: 'Add',
              },
            ]}
          />
          <div className={css({width: '12px'})} />
        </div>
        <div className={css({height: '100%', margin: '0 20px 20px'})}>
          <StatefulDataTable
            rowActions={[
              {
                renderIcon: () => <FiTrash2 />,
              },
            ]}
            resizableColumnWidths
            columns={columns}
            rows={data || []}
          />
        </div>
      </PageWrapper>
    </>
  );
}
