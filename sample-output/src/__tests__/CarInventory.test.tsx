import { MockedProvider } from "@apollo/client/testing";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import CarInventory from "@/components/CarInventory";
import { GET_CARS } from "@/graphql/queries";
import { seedCars } from "@/mocks/data";

function renderInventory() {
  const cars = seedCars.map((car) => ({ ...car, __typename: "Car" as const }));
  return render(
    <MockedProvider
      mocks={[{ request: { query: GET_CARS }, result: { data: { cars } } }]}
    >
      <CarInventory />
    </MockedProvider>,
  );
}

describe("CarInventory", () => {
  it("loads and renders the inventory", async () => {
    renderInventory();

    expect(screen.getByLabelText("Loading inventory")).toBeInTheDocument();
    expect(await screen.findByText("Toyota Camry")).toBeInTheDocument();
    expect(screen.getAllByRole("img")).toHaveLength(seedCars.length);
  });

  it("filters cars by model", async () => {
    const user = userEvent.setup();
    renderInventory();
    await screen.findByText("Toyota Camry");

    await user.type(screen.getByLabelText("Search inventory by model"), "civic");

    expect(screen.getByText("Honda Civic")).toBeInTheDocument();
    expect(screen.queryByText("Toyota Camry")).not.toBeInTheDocument();
  });
});
