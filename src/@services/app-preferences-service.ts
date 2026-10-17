import {observable, runInAction} from 'mobx';

import {FEATURES, type FeatureRoute} from '../@features.js';

import type {StorageService} from './storage-service.js';

declare global {
  // eslint-disable-next-line @typescript-eslint/consistent-type-definitions
  interface StorageMapping {
    defaultFeature: FeatureRoute;
  }
}

export class AppPreferencesService {
  private feature = observable.box<FeatureRoute | undefined>();
  private writing = Promise.resolve();

  private constructor(
    private storage: StorageService,
    feature: FeatureRoute | undefined,
  ) {
    runInAction(() => this.feature.set(feature));
  }

  get defaultFeature(): FeatureRoute | undefined {
    return this.feature.get();
  }

  setDefaultFeature(feature: FeatureRoute | undefined): Promise<void> {
    this.writing = this.writing
      .catch(() => {})
      .then(async () => {
        if (feature) {
          await this.storage.set('defaultFeature', feature);
        } else {
          await this.storage.remove('defaultFeature');
        }

        runInAction(() => this.feature.set(feature));
      });

    return this.writing;
  }

  static async create(storage: StorageService): Promise<AppPreferencesService> {
    const saved = await storage.get('defaultFeature');
    const feature = FEATURES.find(({route}) => route === saved)?.route;
    return new AppPreferencesService(storage, feature);
  }
}
