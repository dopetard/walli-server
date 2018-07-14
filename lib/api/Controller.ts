import UserManager from '../users/UserManager';

// TODO: HTTP codes for failed requests
class Controller {

  constructor(private userManager: UserManager) {}

  public addUser = async (_req, res) => {
    const user = await this.userManager.addUser();
    res.json({ user });
  }

  public sendPayment = async (req, res) => {
    const { user, invoice } = req.body;
    let error = '';
    try {
      error = await this.userManager.sendPayment(user, invoice);
    } catch (exception) {
      error = exception.message;
    }
    res.json({ error });
  }

  public getInvoice = async (req, res) => {
    const { user, currency, amount, memo } = req.body;
    try {
      const invoice = await this.userManager.getInvoice(user, currency, amount, memo);
      res.json({ invoice });
    } catch (exception) {
      this.handleException(exception, res);
    }
  }

  public getBalance = async (req, res) => {
    const { user, currency } = req.body;
    try {
      const balance = await this.userManager.getBalance(user, currency);
      res.json({ balance });
    } catch (exception) {
      this.handleException(exception, res);
    }
  }

  public getBalances = async (req, res) => {
    const { user } = req.body;
    try {
      const balances = await this.userManager.getBalances(user);
      res.json({ balances });
    } catch (exception) {
      this.handleException(exception, res);
    }
  }

  private handleException = (exception: any, res: any) => {
    res.json({ error: exception.message });
  }
}

export default Controller;
