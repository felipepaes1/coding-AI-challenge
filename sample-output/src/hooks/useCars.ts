import { useQuery, type ApolloError } from "@apollo/client";
import { GET_CARS } from "../graphql/queries";
import type { Car, GetCarsData } from "../types";

export interface UseCarsResult {
  cars: Car[];
  loading: boolean;
  error?: ApolloError;
  refetch: () => Promise<unknown>;
}

/** Loads the inventory and exposes Apollo's refresh capability to consumers. */
export function useCars(): UseCarsResult {
  const { data, loading, error, refetch } = useQuery<GetCarsData>(GET_CARS);

  return {
    cars: data?.cars ?? [],
    loading,
    error,
    refetch: () => refetch(),
  };
}
