import { getEnvName } from "@/utils/env";

export const getAnswersCollectionName = () => {
  const env = getEnvName();
  return `${env}_chatLogs`;
};

export const getUsersCollectionName = () => {
  const env = getEnvName();
  return `${env}_users`;
};

export const getNewslettersCollectionName = () => {
  const env = getEnvName();
  return `${env}_newsletters`;
};

export const getSuggestionsInteractionsCollectionName = () => {
  const env = getEnvName();
  return `${env}_suggestions_interactions`;
};

export const getModelPerformanceCollectionName = () => {
  const env = getEnvName();
  return `${env}_model_performance`;
};
