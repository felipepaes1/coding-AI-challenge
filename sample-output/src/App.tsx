import { Box, Chip, Container, Stack, Typography } from "@mui/material";
import DirectionsCarOutlinedIcon from "@mui/icons-material/DirectionsCarOutlined";
import CarInventory from "./components/CarInventory";

export default function App() {
  return (
    <Box sx={{ minHeight: "100vh", bgcolor: "background.default" }}>
      <Box
        component="header"
        sx={{
          borderBottom: 1,
          borderColor: "divider",
          bgcolor: "background.paper",
        }}
      >
        <Container maxWidth="lg" sx={{ py: { xs: 3, sm: 4 } }}>
          <Stack direction="row" spacing={2} alignItems="center">
            <Box
              sx={{
                display: "grid",
                placeItems: "center",
                width: 48,
                height: 48,
                borderRadius: 2,
                bgcolor: "primary.main",
                color: "primary.contrastText",
              }}
            >
              <DirectionsCarOutlinedIcon />
            </Box>
            <Box>
              <Typography variant="overline" color="primary.main" sx={{ fontWeight: 700, letterSpacing: 1.4 }}>
                Fleet overview
              </Typography>
              <Typography variant="h4" component="h1" sx={{ fontWeight: 700, lineHeight: 1.15 }}>
                Car Inventory Manager
              </Typography>
            </Box>
          </Stack>
        </Container>
      </Box>

      <Container component="main" maxWidth="lg" sx={{ py: { xs: 4, sm: 6 } }}>
        <Stack spacing={1} sx={{ mb: 4 }}>
          <Chip label="Live inventory" color="success" size="small" sx={{ alignSelf: "flex-start", fontWeight: 600 }} />
          <Typography variant="h5" component="h2" sx={{ fontWeight: 650 }}>
            Browse your vehicles
          </Typography>
          <Typography color="text.secondary" sx={{ maxWidth: 620 }}>
            Search the collection by model or sort it by year and make to quickly find the right vehicle.
          </Typography>
        </Stack>
        <CarInventory />
      </Container>
    </Box>
  );
}
